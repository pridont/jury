import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../src/util/exec.js';
import { findRepo, type Repo } from '../../src/git/repo.js';
import { acquire } from '../../src/git/source.js';
import { reconcileMarks } from '../../src/state/reconcile.js';
import { emptyReview, load, save } from '../../src/state/store.js';
import type { Hunk } from '../../src/model/types.js';

let dir: string;
let repo: Repo;

const git = (...args: string[]) => run('git', args, { cwd: dir });
const write = async (rel: string, body: string) => {
  await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), body);
};
const commit = async (message: string) => {
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
};

/** Nine separated one-line edits across three files, so the diff has nine hunks. */
const SPACER = Array.from({ length: 12 }, (_, i) => `spacer ${i}`).join('\n');
const body = (values: [number, number, number]) =>
  values.map((v, i) => `${SPACER}\nvalue ${i} = ${v}`).join('\n') + '\n';

const branchHunks = async (): Promise<Hunk[]> => {
  const acquired = await acquire(repo, { kind: 'range', base: 'main', head: 'HEAD', threeDot: true });
  return acquired.files.flatMap((file) => file.hunks);
};

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'changestack-refresh-')));
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');

  for (const name of ['a', 'b', 'c']) await write(`src/${name}.ts`, body([0, 0, 0]));
  await commit('base');
  repo = (await findRepo(dir))!;

  await git('checkout', '-q', '-b', 'feature');
  await write('src/a.ts', body([1, 2, 3]));
  await write('src/b.ts', body([4, 5, 6]));
  await write('src/c.ts', body([7, 8, 9]));
  await commit('nine changes');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('refresh after the author pushes again', () => {
  it('resets only the marked hunk that actually changed', async () => {
    const before = await branchHunks();
    expect(before).toHaveLength(9);

    // Mark five of the nine.
    const marked = new Set(before.slice(0, 5).map((h) => h.id));
    const amendedMarked = before[2]!;
    const amendedUnmarked = before[7]!;

    // The author amends one marked hunk and one unmarked one.
    await write('src/a.ts', body([1, 2, 33]));
    await write('src/c.ts', body([7, 88, 9]));
    await git('commit', '-q', '-a', '--amend', '-m', 'nine changes');

    const after = await branchHunks();
    const { marks, report } = reconcileMarks(before, after, marked);

    expect(report).toEqual({ kept: 4, changed: 1, gone: 0 });
    expect(marks.size).toBe(4);
    expect(marks.has(amendedMarked.id)).toBe(false);
    expect(marks.has(amendedUnmarked.id)).toBe(false);

    // The four that were not touched are still ticked, and nothing else moved.
    for (const hunk of before.slice(0, 5)) {
      if (hunk.id === amendedMarked.id) continue;
      expect(marks.has(hunk.id), hunk.path).toBe(true);
    }
  });

  it('keeps every mark when the branch is only rebased', async () => {
    const before = await branchHunks();
    const marked = new Set(before.map((h) => h.id));

    await git('checkout', '-q', 'main');
    await write('src/a.ts', `header\n${body([0, 0, 0])}`);
    await commit('main grows a header');
    await git('checkout', '-q', 'feature');
    await git('rebase', '-q', 'main');

    const after = await branchHunks();
    const { marks, report } = reconcileMarks(before, after, marked);

    expect(report).toEqual({ kept: 9, changed: 0, gone: 0 });
    expect(marks.size).toBe(9);
  });

  it('reports a hunk the author reverted as gone, not as changed', async () => {
    const before = await branchHunks();
    const marked = new Set([before[0]!.id]);

    await write('src/a.ts', body([0, 2, 3]));
    await git('commit', '-q', '-a', '--amend', '-m', 'nine changes');

    const { report } = reconcileMarks(before, await branchHunks(), marked);
    expect(report).toEqual({ kept: 0, changed: 0, gone: 1 });
  });

  it('carries progress across a quit and resume', async () => {
    const before = await branchHunks();
    const spec = { kind: 'range', base: 'main', head: 'HEAD', threeDot: true } as const;

    const review = emptyReview(repo, spec);
    review.marks = before.slice(0, 3).map((h) => h.id);
    await save(repo, review);

    // A fresh process, the same repository, the same spec.
    const reopened = (await findRepo(dir))!;
    const stored = await load(reopened, review.id);
    const { marks, report } = reconcileMarks(before, await branchHunks(), new Set(stored!.marks));

    expect(report.kept).toBe(3);
    expect(marks.size).toBe(3);
  });
});
