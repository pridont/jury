import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findRepo, stateDir, currentBranch } from '../../src/git/repo.js';
import { run } from '../../src/util/exec.js';

let tmp: string;
let repoRoot: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'jury-'));
  repoRoot = await fs.realpath(tmp);
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  await run('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, 'a.txt'), 'one\n');
  await run('git', ['add', '.'], { cwd: repoRoot });
  await run('git', ['commit', '-q', '-m', 'first'], { cwd: repoRoot });
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('findRepo', () => {
  it('resolves the root from a subdirectory', async () => {
    const nested = path.join(repoRoot, 'src', 'deep');
    await fs.mkdir(nested, { recursive: true });
    const repo = await findRepo(nested);
    expect(repo?.root).toBe(repoRoot);
  });

  it('returns null outside a repository rather than throwing', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'jury-bare-'));
    try {
      expect(await findRepo(outside)).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('reports the main worktree as not linked', async () => {
    const repo = await findRepo(repoRoot);
    expect(repo?.linkedWorktree).toBe(false);
  });

  it('resolves the common dir from a linked worktree, so state is shared', async () => {
    const linked = path.join(repoRoot, '..', path.basename(repoRoot) + '-wt');
    await run('git', ['worktree', 'add', '-q', '-b', 'side', linked], { cwd: repoRoot });
    try {
      const main = await findRepo(repoRoot);
      const side = await findRepo(await fs.realpath(linked));
      expect(side?.linkedWorktree).toBe(true);
      expect(side?.commonDir).toBe(main?.commonDir);
      expect(stateDir(side!)).toBe(stateDir(main!));
    } finally {
      await run('git', ['worktree', 'remove', '--force', linked], { cwd: repoRoot });
    }
  });
});

describe('currentBranch', () => {
  it('names the checked-out branch', async () => {
    const repo = await findRepo(repoRoot);
    expect(await currentBranch(repo!)).toBe('main');
  });

  it('is null on a detached HEAD', async () => {
    const repo = await findRepo(repoRoot);
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    await run('git', ['checkout', '-q', '--detach', head], { cwd: repoRoot });
    try {
      expect(await currentBranch(repo!)).toBeNull();
    } finally {
      await run('git', ['checkout', '-q', 'main'], { cwd: repoRoot });
    }
  });
});
