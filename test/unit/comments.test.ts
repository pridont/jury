import { describe, expect, it } from 'vitest';
import { commentLine, commentOffset, hunkAt, newComment, reconcileComments } from '../../src/model/comments.js';
import { reanchor } from '../../src/state/anchor.js';
import { hunkBody, hunkId } from '../../src/git/identity.js';
import type { Comment, Hunk } from '../../src/model/types.js';

const hunk = (path: string, lines: string[], newStart = 1, oldStart = newStart): Hunk => ({
  id: hunkId(path, hunkBody(lines)),
  path,
  oldStart,
  oldCount: lines.filter((l) => !l.startsWith('+')).length,
  newStart,
  newCount: lines.filter((l) => !l.startsWith('-')).length,
  lines,
  stats: {
    added: lines.filter((l) => l.startsWith('+')).length,
    removed: lines.filter((l) => l.startsWith('-')).length,
  },
  kind: 'text',
});

describe('anchoring a note to a hunk, not to a line', () => {
  const target = hunk('a.ts', [' ctx', '-old', '+new', ' ctx'], 40, 38);

  it('round-trips a line through offset and back', () => {
    const offset = commentOffset(target, 'new', 42);
    expect(offset).toBe(2);
    expect(commentLine(target, { offset, side: 'new' })).toBe(42);
  });

  it('reads the offset against the side it was left on', () => {
    expect(commentLine(target, { offset: 1, side: 'old' })).toBe(39);
    expect(commentLine(target, { offset: 1, side: 'new' })).toBe(41);
  });

  it('holds its place when the hunk moves', () => {
    const moved = { ...target, newStart: 90 };
    const offset = commentOffset(target, 'new', 42);
    expect(commentLine(moved, { offset, side: 'new' })).toBe(92);
  });

  it('never produces a negative offset', () => {
    expect(commentOffset(target, 'new', 1)).toBe(0);
  });
});

describe('hunkAt', () => {
  const hunks = [hunk('a.ts', [' c', '-x', '+y'], 10), hunk('a.ts', [' c', '-p', '+q'], 50)];

  it('finds the hunk a line falls inside', () => {
    expect(hunkAt(hunks, 'new', 11)?.newStart).toBe(10);
    expect(hunkAt(hunks, 'new', 51)?.newStart).toBe(50);
  });

  it('is null between hunks, so a note cannot be left on unchanged context', () => {
    expect(hunkAt(hunks, 'new', 30)).toBeNull();
  });
});

describe('reconcileComments', () => {
  const before = hunk('a.ts', ['-if (a) return;', '+if (a || b) return;']);
  const after = hunk('a.ts', ['-if (a) return;', '+if (a || b || c) return;']);
  const same = hunk('a.ts', ['-if (a) return;', '+if (a || b) return;'], 90);

  const noteOn = (id: string): Comment => newComment(id, 1, 'new', 'is this the right boundary?');

  it('follows an exact match with no flag', () => {
    const anchors = reanchor([before], [same]);
    const { comments, moved, orphaned } = reconcileComments([noteOn(before.id)], anchors);
    expect(comments[0]).toMatchObject({ hunkId: same.id, moved: false, orphaned: false });
    expect({ moved, orphaned }).toEqual({ moved: 0, orphaned: 0 });
  });

  it('follows a fuzzy match and says the position is a guess', () => {
    const anchors = reanchor([before], [after]);
    const { comments, moved } = reconcileComments([noteOn(before.id)], anchors);
    expect(comments[0]).toMatchObject({ hunkId: after.id, moved: true, orphaned: false });
    expect(moved).toBe(1);
  });

  it('keeps a note whose code is gone, marked orphaned rather than deleted', () => {
    const anchors = reanchor([before], []);
    const { comments, orphaned } = reconcileComments([noteOn(before.id)], anchors);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ orphaned: true });
    expect(comments[0]!.body).toBe('is this the right boundary?');
    expect(orphaned).toBe(1);
  });

  it('takes a fuzzy match where a mark would have refused one', () => {
    // The same anchor map drives both, and they make opposite calls on purpose.
    const anchors = reanchor([before], [after]);
    expect(anchors.get(before.id)!.kind).toBe('moved');
    const { comments } = reconcileComments([noteOn(before.id)], anchors);
    expect(comments[0]!.orphaned).toBe(false);
  });

  it('clears a stale flag when the note lands exactly again', () => {
    const stale = { ...noteOn(before.id), moved: true, orphaned: true };
    const { comments } = reconcileComments([stale], reanchor([before], [same]));
    expect(comments[0]).toMatchObject({ moved: false, orphaned: false });
  });
});
