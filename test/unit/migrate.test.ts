import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../src/util/exec.js';
import { findRepo, stateDir, type Repo } from '../../src/git/repo.js';
import { migrateLegacyState } from '../../src/state/migrate.js';

let dir: string;
let repo: Repo;

const git = (...args: string[]) => run('git', args, { cwd: dir });
const legacy = () => path.join(repo.commonDir, 'changestack');

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jury-migrate-')));
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(dir, 'a.txt'), 'a\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'base');
  repo = (await findRepo(dir))!;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('migrateLegacyState', () => {
  it('carries reviews and cached answers over to the new name', async () => {
    await fs.mkdir(path.join(legacy(), 'cache'), { recursive: true });
    await fs.writeFile(path.join(legacy(), 'review.json'), '{"marks":["a"]}');
    await fs.writeFile(path.join(legacy(), 'cache', 'answer.txt'), 'cached');

    const result = await migrateLegacyState(repo);

    expect(result.movedState).toBe(true);
    expect(await fs.readFile(path.join(stateDir(repo), 'review.json'), 'utf8')).toBe('{"marks":["a"]}');
    expect(await fs.readFile(path.join(stateDir(repo), 'cache', 'answer.txt'), 'utf8')).toBe('cached');
    await expect(fs.access(legacy())).rejects.toThrow();
  });

  it('leaves both alone when state already exists under the new name', async () => {
    await fs.mkdir(legacy(), { recursive: true });
    await fs.writeFile(path.join(legacy(), 'old.json'), 'old');
    await fs.mkdir(stateDir(repo), { recursive: true });
    await fs.writeFile(path.join(stateDir(repo), 'new.json'), 'new');

    const result = await migrateLegacyState(repo);

    expect(result.movedState).toBe(false);
    expect(await fs.readFile(path.join(stateDir(repo), 'new.json'), 'utf8')).toBe('new');
    expect(await fs.readFile(path.join(legacy(), 'old.json'), 'utf8')).toBe('old');
  });

  it('removes the pull request refs it fetched under the old name, and nothing else', async () => {
    const head = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('update-ref', 'refs/changestack/pr-141', head);
    await git('update-ref', 'refs/changestack/pr-137', head);
    await git('update-ref', 'refs/someone-else/keep', head);

    const result = await migrateLegacyState(repo);

    expect(result.removedRefs).toBe(2);
    expect((await git('for-each-ref', '--format=%(refname)', 'refs/changestack/')).stdout.trim()).toBe('');
    expect((await git('rev-parse', '--verify', 'refs/someone-else/keep')).code).toBe(0);
  });

  it('does nothing on a repository that never had the old name', async () => {
    expect(await migrateLegacyState(repo)).toEqual({ movedState: false, removedRefs: 0 });
  });

  it('is safe to run on every open', async () => {
    await fs.mkdir(legacy(), { recursive: true });
    await fs.writeFile(path.join(legacy(), 'review.json'), '{}');

    await migrateLegacyState(repo);
    expect(await migrateLegacyState(repo)).toEqual({ movedState: false, removedRefs: 0 });
  });
});
