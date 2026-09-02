import { describe, expect, it } from 'vitest';
import { lineOverlap, reanchor, similarity } from '../../src/state/anchor.js';
import { reconcileMarks, describeRefresh } from '../../src/state/reconcile.js';
import { hunkBody, hunkId } from '../../src/git/identity.js';
import type { Hunk } from '../../src/model/types.js';

const hunk = (path: string, lines: string[], newStart = 1): Hunk => ({
  id: hunkId(path, hunkBody(lines)),
  path,
  oldStart: newStart,
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

describe('lineOverlap', () => {
  it('is 1 for identical lines and 0 for unrelated ones', () => {
    expect(lineOverlap('return a;', 'return a;')).toBe(1);
    expect(lineOverlap('abc', 'xyz')).toBe(0);
  });

  it('gives most of the credit to a line that gained a clause', () => {
    expect(lineOverlap('if (a) return;', 'if (a && b) return;')).toBeGreaterThan(0.7);
  });

  it('counts the shared ends, not the middle', () => {
    expect(lineOverlap('const x = compute();', 'const x = recompute();')).toBeGreaterThan(0.8);
  });
});

describe('similarity', () => {
  it('is 1 for the same content', () => {
    const lines = [' ctx', '-old', '+new'];
    expect(similarity(hunk('a.ts', lines), hunk('a.ts', lines, 40))).toBe(1);
  });

  it('refuses to let a line and its own deletion vouch for each other', () => {
    const forward = hunk('a.ts', ['-x', '+y']);
    const reverted = hunk('a.ts', ['-y', '+x']);
    expect(similarity(forward, reverted)).toBe(0);
  });

  it('recognises a one-line change that later gained a clause', () => {
    const before = hunk('a.ts', ['-if (a) return;', '+if (a || b) return;']);
    const after = hunk('a.ts', ['-if (a) return;', '+if (a || b || c) return;']);
    expect(similarity(before, after)).toBeGreaterThan(0.8);
  });

  it('does not accumulate unrelated lines into a match', () => {
    const before = hunk('a.ts', ['+alpha', '+beta', '+gamma']);
    const after = hunk('a.ts', ['+one', '+two', '+three']);
    expect(similarity(before, after)).toBeLessThan(0.3);
  });
});

describe('reanchor', () => {
  it('matches an unchanged hunk exactly, wherever it moved to', () => {
    const before = hunk('a.ts', [' ctx', '-old', '+new'], 10);
    const after = hunk('a.ts', [' ctx', '-old', '+new'], 90);
    const anchors = reanchor([before], [after]);
    expect(anchors.get(before.id)).toEqual({ kind: 'exact', hunkId: after.id });
  });

  it('calls an edited hunk moved, and says how sure it is', () => {
    const before = hunk('a.ts', ['-if (a) return;', '+if (a || b) return;']);
    const after = hunk('a.ts', ['-if (a) return;', '+if (a || b || c) return;']);
    const anchor = anchorOf(reanchor([before], [after]), before.id);
    expect(anchor.kind).toBe('moved');
  });

  it('never matches across files', () => {
    const before = hunk('a.ts', ['-x', '+y']);
    const after = hunk('b.ts', ['-x', '+y']);
    expect(reanchor([before], [after]).get(before.id)).toEqual({ kind: 'orphaned' });
  });

  it('orphans a hunk that is simply gone', () => {
    const before = hunk('a.ts', ['-x', '+y']);
    expect(reanchor([before], []).get(before.id)).toEqual({ kind: 'orphaned' });
  });

  it('does not let two hunks claim the same replacement', () => {
    const one = hunk('a.ts', ['-if (a) return 1;', '+if (a || b) return 1;'], 5);
    const two = hunk('a.ts', ['-if (a) return 2;', '+if (a || b) return 2;'], 50);
    const after = hunk('a.ts', ['-if (a) return 1;', '+if (a || b || c) return 1;'], 5);

    const anchors = reanchor([one, two], [after]);
    const claimed = [...anchors.values()].filter((a) => a.kind === 'moved');
    expect(claimed).toHaveLength(1);
    expect(anchors.get(one.id)!.kind).toBe('moved');
    expect(anchors.get(two.id)).toEqual({ kind: 'orphaned' });
  });
});

describe('reconcileMarks', () => {
  const stable = hunk('a.ts', [' ctx', '-old', '+new'], 10);
  const moved = hunk('a.ts', [' ctx', '-old', '+new'], 90);
  const edited = hunk('b.ts', ['-if (a) return;', '+if (a || b) return;']);
  const editedAgain = hunk('b.ts', ['-if (a) return;', '+if (a || b || c) return;']);
  const vanished = hunk('c.ts', ['-x', '+y']);

  it('keeps a mark whose hunk came back untouched', () => {
    const { marks, report } = reconcileMarks([stable], [moved], new Set([stable.id]));
    expect(marks.has(moved.id)).toBe(true);
    expect(report).toEqual({ kept: 1, changed: 0, gone: 0 });
  });

  it('refuses to carry a mark onto a hunk that changed, however similar', () => {
    const { marks, report } = reconcileMarks([edited], [editedAgain], new Set([edited.id]));
    expect(marks.size).toBe(0);
    expect(report).toEqual({ kept: 0, changed: 1, gone: 0 });
  });

  it('counts a mark whose hunk is gone separately from one that changed', () => {
    const { report } = reconcileMarks([vanished], [], new Set([vanished.id]));
    expect(report).toEqual({ kept: 0, changed: 0, gone: 1 });
  });

  it('leaves unmarked hunks out of the report entirely', () => {
    const { report } = reconcileMarks([stable, edited], [moved, editedAgain], new Set([stable.id]));
    expect(report).toEqual({ kept: 1, changed: 0, gone: 0 });
  });

  it('ignores a stale mark from an older state file', () => {
    const { report, marks } = reconcileMarks([stable], [moved], new Set([stable.id, 'nonsense']));
    expect(marks.size).toBe(1);
    expect(report).toEqual({ kept: 1, changed: 0, gone: 0 });
  });
});

describe('describeRefresh', () => {
  it('says what happened, and stays quiet about what did not', () => {
    expect(describeRefresh({ kept: 5, changed: 0, gone: 0 })).toBe('refreshed · 5 marks kept');
    expect(describeRefresh({ kept: 5, changed: 2, gone: 1 })).toBe('refreshed · 5 marks kept · 2 changed · 1 gone');
  });
});

function anchorOf(anchors: Map<string, { kind: string }>, id: string) {
  return anchors.get(id)!;
}
