import { describe, expect, it } from 'vitest';
import { fullyMarked } from '../../src/github/pr.js';
import type { FileChange } from '../../src/git/parse.js';

const file = (path: string, hunkIds: string[]): FileChange => ({
  path,
  status: 'modified',
  binary: false,
  hunks: hunkIds.map((id) => ({
    id,
    path,
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    lines: ['-a', '+b'],
    stats: { added: 1, removed: 1 },
    kind: 'text' as const,
  })),
  stats: { added: 1, removed: 1 },
});

describe('fullyMarked', () => {
  const files = [file('a.ts', ['a1', 'a2']), file('b.ts', ['b1']), file('empty.ts', [])];

  it('is the files whose every hunk is marked', () => {
    expect(fullyMarked(files, new Set(['a1', 'a2', 'b1']))).toEqual(new Set(['a.ts', 'b.ts']));
  });

  it('leaves out a file with a hunk still unmarked', () => {
    expect(fullyMarked(files, new Set(['a1', 'b1']))).toEqual(new Set(['b.ts']));
  });

  it('never counts a file with no hunks as viewed', () => {
    expect(fullyMarked(files, new Set())).toEqual(new Set());
  });
});
