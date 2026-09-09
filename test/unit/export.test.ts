import { describe, expect, it } from 'vitest';
import { toMarkdown } from '../../src/export.js';
import { heuristicCohorts } from '../../src/model/heuristic.js';
import { newComment } from '../../src/model/comments.js';
import type { FileChange } from '../../src/git/parse.js';
import type { Hunk } from '../../src/model/types.js';

let counter = 0;
const file = (path: string, newStart = 10, scaffolding = false): FileChange => {
  counter += 1;
  const hunk: Hunk = {
    id: `h${counter}`,
    path,
    oldStart: newStart,
    oldCount: 3,
    newStart,
    newCount: 3,
    lines: [' ctx', '-old', '+new'],
    stats: { added: 1, removed: 1 },
    kind: 'text',
  };
  if (scaffolding) hunk.scaffolding = { reason: 'lockfile' };
  return { path, status: 'modified', binary: false, hunks: [hunk], stats: { added: 1, removed: 1 } };
};

const render = (files: FileChange[], comments = [] as ReturnType<typeof newComment>[], marks = new Set<string>()) =>
  toMarkdown({
    spec: { kind: 'range', base: 'main', head: 'HEAD', threeDot: true },
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    cohorts: heuristicCohorts(files),
    files,
    comments,
    marks,
  });

describe('toMarkdown', () => {
  it('leads with what was reviewed and how much of it', () => {
    const files = [file('src/a.ts'), file('src/b.ts')];
    const out = render(files, [], new Set([files[0]!.hunks[0]!.id]));

    expect(out).toContain('# Review — main...HEAD');
    expect(out).toContain('2 files · 2 hunks · 1 reviewed · 0 comments');
    expect(out).toContain('`aaaaaaaaaaaa` → `bbbbbbbbbbbb`');
  });

  it('groups notes by cohort, not by path', () => {
    const files = [file('src/auth.ts'), file('src/auth.spec.ts')];
    const note = newComment(files[0]!.hunks[0]!.id, 1, 'new', 'boundary looks off by one');
    const out = render(files, [note]);

    expect(out).toContain('## 1. auth.ts and its test');
    expect(out).toContain('### src/auth.ts');
    expect(out).toContain('boundary looks off by one');
  });

  it('gives every note a file:line a colleague can jump to', () => {
    const files = [file('src/a.ts', 40)];
    const out = render(files, [newComment(files[0]!.hunks[0]!.id, 2, 'new', 'here')]);
    expect(out).toContain('**src/a.ts:42**');
  });

  it('says when a position is only a guess', () => {
    const files = [file('src/a.ts')];
    const note = { ...newComment(files[0]!.hunks[0]!.id, 0, 'new', 'still relevant?'), moved: true };
    expect(render(files, [note])).toContain('_(position is approximate)_');
  });

  it('lists orphaned notes separately instead of dropping them', () => {
    const files = [file('src/a.ts')];
    const note = { ...newComment('gone', 0, 'new', 'what happened to the guard?'), orphaned: true };
    const out = render(files, [note]);

    expect(out).toContain('## Comments whose code is gone');
    expect(out).toContain('what happened to the guard?');
  });

  it('omits a cohort nobody wrote anything about', () => {
    const files = [file('src/a.ts'), file('src/b.ts')];
    const out = render(files, [newComment(files[0]!.hunks[0]!.id, 0, 'new', 'note')]);
    expect(out).toContain('### src/a.ts');
    expect(out).not.toContain('### src/b.ts');
  });

  it('does not count generated files as work the reviewer skipped', () => {
    const files = [file('src/a.ts'), file('yarn.lock', 1, true)];
    const out = render(files, [], new Set([files[0]!.hunks[0]!.id]));

    expect(out).toContain('1 hunks · 1 reviewed');
    expect(out).toContain('1 generated files were not reviewed');
    expect(out).not.toContain('## 2. yarn.lock');
  });

  it('is readable with nothing in it at all', () => {
    expect(render([])).toContain('0 files · 0 hunks · 0 reviewed · 0 comments');
  });
});
