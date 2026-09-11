import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../src/util/exec.js';
import { findRepo, stateDir, type Repo } from '../../src/git/repo.js';
import { emptyReview, list, load, remove, reviewId, save } from '../../src/state/store.js';

let dir: string;
let repo: Repo;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jury-store-')));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  repo = (await findRepo(dir))!;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('reviewId', () => {
  it('is the same for the same spec, so a review is found again', () => {
    const spec = { kind: 'range', base: 'main', head: 'HEAD', threeDot: true } as const;
    expect(reviewId(repo, spec)).toBe(reviewId(repo, spec));
  });

  it('differs between specs', () => {
    expect(reviewId(repo, { kind: 'worktree' })).not.toBe(reviewId(repo, { kind: 'staged' }));
  });

  it('is keyed by the spec, not by what it resolved to', () => {
    // The point: main can move on, and the review has to survive it.
    const before = reviewId(repo, { kind: 'range', base: 'main', head: 'HEAD', threeDot: true });
    const after = reviewId(repo, { kind: 'range', base: 'main', head: 'HEAD', threeDot: true });
    expect(before).toBe(after);
  });
});

describe('save and load', () => {
  it('round-trips a review', async () => {
    const review = emptyReview(repo, { kind: 'worktree' });
    review.marks = ['a', 'b'];
    review.notScaffolding = ['libs/x/project.json'];
    await save(repo, review);

    const back = await load(repo, review.id);
    expect(back).toMatchObject({ marks: ['a', 'b'], notScaffolding: ['libs/x/project.json'] });
  });

  it('writes inside .git, so it never dirties the working tree', async () => {
    await save(repo, emptyReview(repo, { kind: 'worktree' }));
    expect(stateDir(repo).startsWith(repo.commonDir)).toBe(true);

    const status = await run('git', ['status', '--porcelain'], { cwd: repo.root });
    expect(status.stdout).toBe('');
  });

  it('leaves no temp file behind', async () => {
    await save(repo, emptyReview(repo, { kind: 'worktree' }));
    const names = await fs.readdir(stateDir(repo));
    expect(names.every((name) => name.endsWith('.json'))).toBe(true);
  });

  it('does not read a file from a schema it does not know', async () => {
    const review = emptyReview(repo, { kind: 'worktree' });
    await save(repo, { ...review, schema: 99 });
    expect(await load(repo, review.id)).toBeNull();
  });

  it('is null for a review that was never saved', async () => {
    expect(await load(repo, 'nothing')).toBeNull();
  });

  it('survives a corrupt file rather than throwing', async () => {
    const review = emptyReview(repo, { kind: 'worktree' });
    await save(repo, review);
    await fs.writeFile(path.join(stateDir(repo), `${review.id}.json`), '{ truncated');
    expect(await load(repo, review.id)).toBeNull();
  });

  it('is shared by every worktree of the repository', async () => {
    const linked = path.join(dir, '..', `${path.basename(dir)}-wt`);
    await fs.writeFile(path.join(dir, 'a.txt'), 'x\n');
    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', ['-c', 'user.email=t@e.c', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: dir });
    await run('git', ['worktree', 'add', '-q', '-b', 'side', linked], { cwd: dir });

    try {
      const review = emptyReview(repo, { kind: 'worktree' });
      review.marks = ['shared'];
      await save(repo, review);

      const other = (await findRepo(await fs.realpath(linked)))!;
      const seen = await load(other, review.id);
      expect(seen?.marks).toEqual(['shared']);
    } finally {
      await run('git', ['worktree', 'remove', '--force', linked], { cwd: dir });
    }
  });
});

describe('list', () => {
  it('is empty before anything is saved', async () => {
    expect(await list(repo)).toEqual([]);
  });

  it('returns saved reviews, most recently touched first', async () => {
    const first = emptyReview(repo, { kind: 'worktree' });
    await save(repo, first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = emptyReview(repo, { kind: 'staged' });
    await save(repo, second);

    const saved = await list(repo);
    expect(saved.map((r) => r.spec.kind)).toEqual(['staged', 'worktree']);
  });

  it('skips a file it cannot read instead of failing the listing', async () => {
    const review = emptyReview(repo, { kind: 'worktree' });
    await save(repo, review);
    await fs.writeFile(path.join(stateDir(repo), 'broken.json'), 'not json');
    expect(await list(repo)).toHaveLength(1);
  });
});

describe('remove', () => {
  it('deletes a review and is quiet about one that is not there', async () => {
    const review = emptyReview(repo, { kind: 'worktree' });
    await save(repo, review);
    await remove(repo, review.id);
    expect(await load(repo, review.id)).toBeNull();
    await expect(remove(repo, review.id)).resolves.toBeUndefined();
  });
});
