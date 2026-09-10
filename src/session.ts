import * as vscode from 'vscode';
import type { Repo } from './git/repo.js';
import type { FileChange } from './git/parse.js';
import type { Cohort, Comment, Review, ReviewSpec } from './model/types.js';
import { describeSpec } from './model/types.js';
import { emptyReview, reviewId, save, type StoredReview } from './state/store.js';

/**
 * The one review that is open, if any.
 *
 * A session owns everything a review allocates — subscriptions, decorations, and later
 * every in-flight model request — so that closing it leaves the editor exactly as it was
 * found and no subprocess behind.
 */
export class Session implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    readonly repo: Repo,
    readonly spec: ReviewSpec,
    /** Null until cohorts are built; the UI must render an opening review, not a lie. */
    public review: Review | null = null,
  ) {
    this.stored = emptyReview(repo, spec);
  }

  /** The parsed diff, in the order git produced it. Grouping replaces this ordering. */
  files: FileChange[] = [];
  /** Resolved revisions, so the review can say exactly what it compared. */
  base = '';
  head = '';
  /** Set when acquisition failed, so the tree can say why instead of looking empty. */
  error: string | null = null;
  loading = true;
  /** Cohorts in reading order. Heuristic until clustering replaces them, once, announced. */
  cohorts: Cohort[] = [];
  /** Hunks the reviewer has ticked. Persisted; carried across a refresh only when exact. */
  marks = new Set<string>();
  /** Paths the reviewer has said are not scaffolding, however they were classified. */
  notScaffolding = new Set<string>();
  /** Review notes. The output of the review, and the thing that gets exported or posted. */
  comments: Comment[] = [];
  /** Per-file summaries as they land, by path. Empty until pass 1 answers, or forever. */
  summaries = new Map<string, string>();
  /** The record on disk. Written after every change the reviewer makes. */
  stored: StoredReview;

  get id(): string {
    return this.stored.id;
  }

  /** Take on previously saved progress for this same review spec. */
  hydrate(stored: StoredReview): void {
    this.stored = stored;
    this.marks = new Set(stored.marks);
    this.notScaffolding = new Set(stored.notScaffolding);
    this.comments = stored.comments.map((comment) => ({ ...comment }));
  }

  /**
   * Write progress to disk. Failure is reported to the caller rather than swallowed: a mark
   * the reviewer believes is saved and is not would be worse than an error.
   */
  async persist(): Promise<void> {
    this.stored.marks = [...this.marks];
    this.stored.notScaffolding = [...this.notScaffolding];
    this.stored.comments = this.comments;
    await save(this.repo, this.stored);
  }

  get hunkCount(): number {
    return this.files.reduce((n, file) => n + file.hunks.length, 0);
  }

  get title(): string {
    return describeSpec(this.spec);
  }

  register(disposable: vscode.Disposable): void {
    this.subscriptions.push(disposable);
  }

  dispose(): void {
    for (const d of this.subscriptions.splice(0)) {
      d.dispose();
    }
  }
}

/** Holds the active session and announces when it is replaced or closed. */
export class SessionHost implements vscode.Disposable {
  private current: Session | null = null;
  private readonly changed = new vscode.EventEmitter<Session | null>();
  readonly onDidChange = this.changed.event;

  get active(): Session | null {
    return this.current;
  }

  open(session: Session): Session {
    this.close();
    this.current = session;
    void vscode.commands.executeCommand('setContext', 'changestack.active', true);
    this.changed.fire(session);
    return session;
  }

  close(): void {
    if (!this.current) return;
    this.current.dispose();
    this.current = null;
    void vscode.commands.executeCommand('setContext', 'changestack.active', false);
    this.changed.fire(null);
  }

  dispose(): void {
    this.close();
    this.changed.dispose();
  }
}
