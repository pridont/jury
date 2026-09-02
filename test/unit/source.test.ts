import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../src/util/exec.js';
import { findRepo, type Repo } from '../../src/git/repo.js';
import { acquire } from '../../src/git/source.js';

let dir: string;
let repo: Repo;

const git = (...args: string[]) => run('git', args, { cwd: dir });
const write = (rel: string, body: string) => fs.writeFile(path.join(dir, rel), body);
const commit = async (message: string) => {
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
};

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'changestack-source-')));
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  repo = (await findRepo(dir))!;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('acquire worktree', () => {
  it('works in a repository with no commits at all', async () => {
    await write('new.txt', 'a\n');
    const result = await acquire(repo, { kind: 'worktree' });
    expect(result.files.map((f) => f.path)).toEqual(['new.txt']);
  });

  it('includes untracked files, which git diff cannot see', async () => {
    await write('tracked.txt', 'one\ntwo\n');
    await commit('base');
    await write('tracked.txt', 'one\nTWO\n');
    await write('untracked.txt', 'brand new\n');

    const result = await acquire(repo, { kind: 'worktree' });
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual(['tracked.txt', 'untracked.txt']);

    const untracked = result.files.find((f) => f.path === 'untracked.txt')!;
    expect(untracked.status).toBe('added');
    expect(untracked.hunks[0]!.lines).toEqual(['+brand new']);
  });

  it('respects .gitignore when synthesising untracked files', async () => {
    await write('.gitignore', 'ignored.txt\n');
    await commit('base');
    await write('ignored.txt', 'noise\n');
    await write('seen.txt', 'signal\n');

    const result = await acquire(repo, { kind: 'worktree' });
    expect(result.files.map((f) => f.path)).toEqual(['seen.txt']);
  });

  it('lists an untracked binary file rather than showing it', async () => {
    await commit_empty();
    await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));

    const result = await acquire(repo, { kind: 'worktree' });
    const file = result.files[0]!;
    expect(file).toMatchObject({ path: 'blob.bin', binary: true });
    expect(file.hunks[0]!.kind).toBe('binary');
  });

  it('marks an untracked file with no trailing newline', async () => {
    await commit_empty();
    await write('partial.txt', 'no newline here');

    const result = await acquire(repo, { kind: 'worktree' });
    expect(result.files[0]!.hunks[0]!.lines).toEqual(['+no newline here', '\\ No newline at end of file']);
  });

  it('gives an untracked empty file a hunk so it can be marked', async () => {
    await commit_empty();
    await write('empty.txt', '');

    const result = await acquire(repo, { kind: 'worktree' });
    expect(result.files[0]!.hunks[0]!.kind).toBe('empty');
  });
});

describe('acquire staged', () => {
  it('sees the index, not the file on disk', async () => {
    await write('a.txt', 'one\n');
    await commit('base');
    await write('a.txt', 'staged\n');
    await git('add', 'a.txt');
    await write('a.txt', 'unstaged\n');

    const result = await acquire(repo, { kind: 'staged' });
    const added = result.files[0]!.hunks[0]!.lines.filter((l) => l.startsWith('+'));
    expect(added).toEqual(['+staged']);
  });
});

describe('acquire range', () => {
  it('three-dot compares against the merge base, not the moving base branch', async () => {
    await write('shared.txt', 'base\n');
    await commit('base');
    await git('checkout', '-q', '-b', 'feature');
    await write('feature.txt', 'from the branch\n');
    await commit('branch work');
    await git('checkout', '-q', 'main');
    await write('main-only.txt', 'main moved on\n');
    await commit('main work');
    await git('checkout', '-q', 'feature');

    const threeDot = await acquire(repo, { kind: 'range', base: 'main', head: 'HEAD', threeDot: true });
    expect(threeDot.files.map((f) => f.path)).toEqual(['feature.txt']);

    const twoDot = await acquire(repo, { kind: 'range', base: 'main', head: 'HEAD', threeDot: false });
    expect(twoDot.files.map((f) => f.path).sort()).toEqual(['feature.txt', 'main-only.txt']);
  });

  it('keeps hunk ids across a rebase that moves the code', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    await write('app.txt', twenty);
    await commit('base');

    await git('checkout', '-q', '-b', 'feature');
    await write('app.txt', twenty.replace('line 15', 'line 15 changed'));
    await commit('the change');

    const before = await acquire(repo, { kind: 'range', base: 'main', head: 'HEAD', threeDot: true });
    const idBefore = before.files[0]!.hunks[0]!.id;

    await git('checkout', '-q', 'main');
    await write('app.txt', 'preamble\npreamble\npreamble\n' + twenty);
    await commit('main grows a header');
    await git('checkout', '-q', 'feature');
    await git('rebase', '-q', 'main');

    const after = await acquire(repo, { kind: 'range', base: 'main', head: 'HEAD', threeDot: true });
    const hunk = after.files[0]!.hunks[0]!;

    expect(hunk.newStart).not.toBe(before.files[0]!.hunks[0]!.newStart);
    expect(hunk.id).toBe(idBefore);
  });

  it('gives a hunk a new id when its own content changes', async () => {
    await write('app.txt', 'a\nb\nc\n');
    await commit('base');
    await git('checkout', '-q', '-b', 'feature');
    await write('app.txt', 'a\nB\nc\n');
    await commit('one');
    const first = await acquire(repo, { kind: 'range', base: 'main', head: 'HEAD', threeDot: true });

    await write('app.txt', 'a\nBB\nc\n');
    await git('commit', '-q', '-a', '--amend', '-m', 'one');
    const second = await acquire(repo, { kind: 'range', base: 'main', head: 'HEAD', threeDot: true });

    expect(second.files[0]!.hunks[0]!.id).not.toBe(first.files[0]!.hunks[0]!.id);
  });
});

async function commit_empty(): Promise<void> {
  await write('.keep', '');
  await commit('base');
}
