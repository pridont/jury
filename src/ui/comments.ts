import * as vscode from 'vscode';
import type { Session } from '../session.js';
import type { Comment } from '../model/types.js';
import { commentLine, commentOffset, hunkAt, newComment } from '../model/comments.js';
import { fileForUri, sidesFor } from './diff.js';

/** A rendered comment, carrying the stored note it came from. */
type Rendered = vscode.Comment & { stored: Comment };

/**
 * Review notes, as native comment threads on the diff.
 *
 * The thread's position is derived, never stored: anchors are `{hunkId, offset, side}`, so a
 * note holds its place when code above it moves, and a note the tool is only guessing about
 * after a refresh says so on its face rather than looking as certain as the rest.
 */
export class Comments implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();
  private session: Session | null = null;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor() {
    this.controller = vscode.comments.createCommentController('changestack', 'Change Stack');
    this.controller.options = { prompt: 'Leave a review note', placeHolder: 'What is worth saying here?' };

    // Only offer to comment where there is actually a hunk. A gutter that invites a note on
    // unchanged context is inviting one nobody will find again.
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.rangesFor(document),
    };
  }

  setSession(session: Session | null): void {
    this.session = session;
    this.clear();
    this.render();
  }

  /** Rebuild every thread from the stored notes. */
  render(): void {
    this.clear();
    const session = this.session;
    if (!session) return;

    for (const comment of session.comments) {
      if (comment.orphaned) continue;
      const thread = this.threadFor(comment);
      if (thread) this.threads.set(comment.id, thread);
    }
  }

  add(reply: vscode.CommentReply): void {
    const session = this.session;
    if (!session || !reply.text.trim()) return;

    const line = reply.thread.range?.start.line ?? 0;
    const located = this.locate(reply.thread.uri, line + 1);
    if (!located) {
      vscode.window.showWarningMessage('Change Stack: a note has to sit on a changed line.');
      reply.thread.dispose();
      return;
    }

    const comment = newComment(located.hunkId, located.offset, located.side, reply.text.trim());
    session.comments.push(comment);

    reply.thread.comments = [this.toRendered(comment)];
    reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.threads.set(comment.id, reply.thread);
    this.changed.fire();
  }

  edit(rendered: vscode.Comment): void {
    const thread = (rendered as Rendered).stored ? this.threads.get((rendered as Rendered).stored.id) : undefined;
    if (!thread) return;
    thread.comments = thread.comments.map((existing: vscode.Comment) =>
      existing === rendered ? { ...existing, mode: vscode.CommentMode.Editing } : existing,
    );
  }

  save(rendered: vscode.Comment): void {
    const session = this.session;
    const stored = (rendered as Rendered).stored;
    if (!session || !stored) return;

    const body = typeof rendered.body === 'string' ? rendered.body : rendered.body.value;
    const comment = session.comments.find((existing) => existing.id === stored.id);
    if (!comment) return;

    // Clearing the text deletes the note: an empty comment is not a comment.
    if (!body.trim()) {
      this.remove(rendered);
      return;
    }

    comment.body = body.trim();
    const thread = this.threads.get(stored.id);
    if (thread) thread.comments = [this.toRendered(comment)];
    this.changed.fire();
  }

  cancel(rendered: vscode.Comment): void {
    const stored = (rendered as Rendered).stored;
    const comment = this.session?.comments.find((existing) => existing.id === stored?.id);
    const thread = stored ? this.threads.get(stored.id) : undefined;
    if (comment && thread) thread.comments = [this.toRendered(comment)];
  }

  remove(rendered: vscode.Comment): void {
    const session = this.session;
    const stored = (rendered as Rendered).stored;
    if (!session || !stored) return;

    session.comments = session.comments.filter((existing) => existing.id !== stored.id);
    this.threads.get(stored.id)?.dispose();
    this.threads.delete(stored.id);
    this.changed.fire();
  }

  /** Put an orphaned note back on a hunk the reviewer picks. */
  repin(comment: Comment, hunkId: string): void {
    comment.hunkId = hunkId;
    comment.offset = 0;
    comment.orphaned = false;
    comment.moved = true;
    this.render();
    this.changed.fire();
  }

  discard(comment: Comment): void {
    const session = this.session;
    if (!session) return;
    session.comments = session.comments.filter((existing) => existing.id !== comment.id);
    this.render();
    this.changed.fire();
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
    this.changed.dispose();
  }

  private clear(): void {
    for (const thread of this.threads.values()) thread.dispose();
    this.threads.clear();
  }

  private rangesFor(document: vscode.TextDocument): vscode.Range[] {
    const session = this.session;
    if (!session) return [];

    const located = fileForUri(session, document.uri);
    if (!located) return [];

    const ranges: vscode.Range[] = [];
    for (const hunk of located.file.hunks) {
      if (hunk.kind !== 'text') continue;
      const start = located.side === 'new' ? hunk.newStart : hunk.oldStart;
      const count = located.side === 'new' ? hunk.newCount : hunk.oldCount;
      if (count === 0) continue;
      const last = Math.min(start + count - 1, document.lineCount);
      if (last < start) continue;
      ranges.push(new vscode.Range(start - 1, 0, last - 1, 0));
    }
    return ranges;
  }

  private locate(
    uri: vscode.Uri,
    line: number,
  ): { hunkId: string; offset: number; side: 'old' | 'new' } | null {
    const session = this.session;
    if (!session) return null;

    const located = fileForUri(session, uri);
    if (!located) return null;

    const hunk = hunkAt(located.file.hunks, located.side, line);
    if (!hunk) return null;

    return { hunkId: hunk.id, offset: commentOffset(hunk, located.side, line), side: located.side };
  }

  private threadFor(comment: Comment): vscode.CommentThread | null {
    const session = this.session;
    if (!session) return null;

    for (const file of session.files) {
      const hunk = file.hunks.find((candidate) => candidate.id === comment.hunkId);
      if (!hunk) continue;

      const sides = sidesFor(session, file);
      const uri = comment.side === 'new' ? sides.after : sides.before;
      const line = Math.max(0, commentLine(hunk, comment) - 1);

      const thread = this.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), [
        this.toRendered(comment),
      ]);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      if (comment.moved) thread.label = 'position is approximate';
      return thread;
    }
    return null;
  }

  private toRendered(comment: Comment): Rendered {
    return {
      body: new vscode.MarkdownString(comment.body),
      mode: vscode.CommentMode.Preview,
      author: { name: 'You' },
      contextValue: 'changestack',
      stored: comment,
    };
  }
}
