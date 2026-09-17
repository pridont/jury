import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../src/util/exec.js';
import { findRepo, type Repo } from '../../src/git/repo.js';
import { defaultBranch, describeCommit, listRefs, recentCommits } from '../../src/git/refs.js';

let dir: string;
let repo: Repo;

const git = (...args: string[]) => run('git', args, { cwd: dir });
const commit = async (message: string, file = 'a.txt') => {
  await fs.writeFile(path.join(dir, file), `${message}\n`);
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
};

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jury-refs-')));
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await commit('first');
  repo = (await findRepo(dir))!;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('listRefs', () => {
  it('lists branches and tags with when and why', async () => {
    await git('tag', 'v1.0.0');
    await git('checkout', '-q', '-b', 'feature');
    await commit('the feature work');

    const refs = await listRefs(repo);
    const names = refs.map((ref) => ref.name);
    expect(names).toContain('main');
    expect(names).toContain('feature');
    expect(names).toContain('v1.0.0');

    const feature = refs.find((ref) => ref.name === 'feature')!;
    expect(feature).toMatchObject({ kind: 'branch', subject: 'the feature work' });
    expect(feature.when).toBeTruthy();
  });

  it('puts the most recently touched first, which is the whole point', async () => {
    // Dated explicitly: two commits in the same second tie, and the alphabetical fallback
    // would decide the order instead of the dates the sort is supposed to be about.
    const dated = (when: string, message: string) =>
      run('git', ['commit', '-q', '--allow-empty', '-m', message], {
        cwd: dir,
        env: { GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when },
      });

    await git('checkout', '-q', '-b', 'aaa-old');
    await dated('2026-01-01T00:00:00Z', 'old work');
    await git('checkout', '-q', '-b', 'zzz-new');
    await dated('2026-06-01T00:00:00Z', 'new work');

    const names = (await listRefs(repo)).map((ref) => ref.name);
    expect(names.indexOf('zzz-new')).toBeLessThan(names.indexOf('aaa-old'));
  });

  it('does not offer our own machinery as a review target', async () => {
    const head = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('update-ref', 'refs/jury/pr-141', head);

    const names = (await listRefs(repo)).map((ref) => ref.name);
    expect(names.some((name) => name.includes('pr-141'))).toBe(false);
  });

  it('survives a subject containing tabs and pipes', async () => {
    await git('checkout', '-q', '-b', 'odd');
    await git('commit', '-q', '--allow-empty', '-m', 'fix\tthing | and | another');

    const odd = (await listRefs(repo)).find((ref) => ref.name === 'odd')!;
    expect(odd.subject).toBe('fix\tthing | and | another');
  });
});

describe('recentCommits', () => {
  it('returns short hashes, newest first', async () => {
    await commit('second');
    await commit('third');

    const commits = await recentCommits(repo, 3);
    expect(commits[0]).toMatchObject({ kind: 'commit', subject: 'third' });
    expect(commits[0]!.name).toMatch(/^[0-9a-f]{7,}$/);
    expect(commits.map((c) => c.subject)).toEqual(['third', 'second', 'first']);
  });
});

describe('defaultBranch', () => {
  it('falls back to a conventional trunk when there is no origin', async () => {
    expect(await defaultBranch(repo)).toBe('main');
  });

  it('is null when nothing conventional exists', async () => {
    await git('branch', '-m', 'main', 'trunk');
    expect(await defaultBranch(repo)).toBeNull();
  });
});

describe('describeCommit', () => {
  it('resolves a revision to the commit it names, with its subject', async () => {
    await commit('the change under review');
    const head = (await git('rev-parse', 'HEAD')).stdout.trim();

    expect(await describeCommit(repo, 'HEAD')).toEqual({ sha: head, subject: 'the change under review' });
    expect(await describeCommit(repo, head.slice(0, 8))).toEqual({
      sha: head,
      subject: 'the change under review',
    });
  });

  it('resolves a tag and a relative revision to the same commit git would', async () => {
    await commit('second');
    await git('tag', 'v1');
    await commit('third');

    const tagged = await describeCommit(repo, 'v1');
    expect(tagged?.subject).toBe('second');
    expect((await describeCommit(repo, 'HEAD~1'))?.sha).toBe(tagged?.sha);
  });

  it('returns null for something that is not a commit, rather than throwing', async () => {
    expect(await describeCommit(repo, 'no-such-revision')).toBeNull();
  });
});
