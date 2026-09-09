import { randomUUID } from 'node:crypto';
import type { Comment, Hunk } from './types.js';
import type { Anchor } from '../state/anchor.js';

/**
 * Where a comment sits in the file, rather than in the hunk.
 *
 * The anchor is `{hunkId, offset, side}` and never a file line number, so a note holds its
 * place when code above it moves. The absolute line only exists to render and to export.
 */
export function commentLine(hunk: Hunk, comment: Pick<Comment, 'offset' | 'side'>): number {
  const start = comment.side === 'new' ? hunk.newStart : hunk.oldStart;
  return start + comment.offset;
}

/** The offset to store for a click at `line` on one side of a hunk. */
export function commentOffset(hunk: Hunk, side: 'old' | 'new', line: number): number {
  const start = side === 'new' ? hunk.newStart : hunk.oldStart;
  return Math.max(0, line - start);
}

/** The hunk a line belongs to, or null when the line is between hunks. */
export function hunkAt(hunks: readonly Hunk[], side: 'old' | 'new', line: number): Hunk | null {
  for (const hunk of hunks) {
    const start = side === 'new' ? hunk.newStart : hunk.oldStart;
    const count = side === 'new' ? hunk.newCount : hunk.oldCount;
    if (count > 0 ? line >= start && line < start + count : line === start) return hunk;
  }
  return null;
}

export function newComment(hunkId: string, offset: number, side: 'old' | 'new', body: string): Comment {
  return {
    id: randomUUID(),
    hunkId,
    offset,
    side,
    body,
    orphaned: false,
    moved: false,
    createdAt: Date.now(),
  };
}

export type CommentReconciliation = {
  comments: Comment[];
  /** How many notes ended up somewhere the tool is only guessing at. */
  moved: number;
  orphaned: number;
};

/**
 * Carry comments across a re-diff.
 *
 * The opposite trade from marks, deliberately. A comment follows a `moved` match and says so,
 * because losing the note entirely is worse than showing it a couple of lines off, and the
 * flag is what tells the reader not to trust the position. A comment whose code is gone is
 * listed as orphaned for the reviewer to re-pin or discard — never silently dropped.
 */
export function reconcileComments(
  comments: readonly Comment[],
  anchors: ReadonlyMap<string, Anchor>,
): CommentReconciliation {
  const out: Comment[] = [];
  let moved = 0;
  let orphaned = 0;

  for (const comment of comments) {
    const anchor = anchors.get(comment.hunkId);

    if (anchor?.kind === 'exact') {
      out.push({ ...comment, hunkId: anchor.hunkId, orphaned: false, moved: false });
    } else if (anchor?.kind === 'moved') {
      out.push({ ...comment, hunkId: anchor.hunkId, orphaned: false, moved: true });
      moved += 1;
    } else {
      out.push({ ...comment, orphaned: true });
      orphaned += 1;
    }
  }

  return { comments: out, moved, orphaned };
}
