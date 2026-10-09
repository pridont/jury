import * as vscode from 'vscode';
import type { Repo } from './git/repo.js';
import type { FileChange } from './git/parse.js';
import type { Cohort, Comment, ReviewSpec } from './model/types.js';
import { describeSpec } from './model/types.js';
import { emptyReview, save, type StoredReview } from './state/store.js';
import type { PullRequest } from './github/pr.js';
import type { RemoteComment } from './github/comments.js';

/** The one review that is open, if any. */
export class Session {
  constructor(
    readonly repo: Repo,
    /** Replaced only by a pull request refresh, which moves it to the newest head. */
    public spec: ReviewSpec,
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
  /** The model's account of the whole change set. Empty until clustering lands. */
  overview = '';
  /** Things worth attention that belong to no single cohort. */
  notes: string[] = [];
  /** Mermaid source, when the change had a shape worth drawing. Empty for small changes. */
  diagram = '';
  /** Set for a pull request review, and what makes submitting possible. */
  pr: PullRequest | null = null;
  /** What other reviewers said on the pull request. Shown, never saved, exported or sent. */
  remoteComments: RemoteComment[] = [];
  /**
   * Files that were fully marked when GitHub was last told, so only a change is sent. Null
   * until a pull request review knows where it starts from.
   */
  viewed: Set<string> | null = null;
  /** The last sync of viewed boxes. Each waits for the one before, so they land in order. */
  viewedSync: Promise<void> = Promise.resolve();
  /** True once clustering has replaced the heuristic stack — which happens exactly once. */
  clustered = false;
  /** The record on disk. Written after every change the reviewer makes. */
  stored: StoredReview;

  /** Bumped by every load, so work started for an older one can tell it has been overtaken. */
  private generation = 0;
  private closed = false;

  /**
   * A check that stays true until this review is reloaded or closed. Anything that awaits a
   * model or git asks it before writing back, so a slow answer for a review that is gone
   * cannot land on the one that replaced it.
   */
  live(): () => boolean {
    const generation = this.generation;
    return () => !this.closed && this.generation === generation;
  }

  /** Start a new load. Whatever is still running for the previous one is now stale. */
  reload(): () => boolean {
    this.generation += 1;
    return this.live();
  }

  close(): void {
    this.closed = true;
  }

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

  /** The hunks among `hunkIds` that live in `path`. */
  hunksIn(hunkIds: readonly string[], path: string): string[] {
    const own = new Set(this.files.find((file) => file.path === path)?.hunks.map((hunk) => hunk.id));
    return hunkIds.filter((id) => own.has(id));
  }

  get hunkCount(): number {
    return this.files.reduce((n, file) => n + file.hunks.length, 0);
  }

  get title(): string {
    return describeSpec(this.spec);
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
    void vscode.commands.executeCommand('setContext', 'jury.active', true);
    void vscode.commands.executeCommand('setContext', 'jury.pr', session.spec.kind === 'pr');
    this.changed.fire(session);
    return session;
  }

  close(): void {
    if (!this.current) return;
    this.current.close();
    this.current = null;
    void vscode.commands.executeCommand('setContext', 'jury.active', false);
    void vscode.commands.executeCommand('setContext', 'jury.pr', false);
    this.changed.fire(null);
  }

  dispose(): void {
    this.close();
    this.changed.dispose();
  }
}
