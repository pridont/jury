import * as path from 'node:path';
import { run, runOk } from '../util/exec.js';

export type Repo = {
  /** Absolute path to the working tree root. */
  root: string;
  /**
   * The common git directory, shared by every worktree of the repository.
   * Review state lives under here so it is found again from any worktree and is
   * never committed.
   */
  commonDir: string;
  /** True when `root` is a linked worktree rather than the main one. */
  linkedWorktree: boolean;
};

export class NotARepositoryError extends Error {
  constructor(readonly cwd: string) {
    super(`${cwd} is not inside a git repository`);
    this.name = 'NotARepositoryError';
  }
}

/**
 * Resolve the repository containing `cwd`, or null when there is none.
 *
 * Returning null rather than throwing is deliberate: "not a git repository" is an
 * ordinary answer the UI turns into one clean message, not an exception to handle.
 */
export async function findRepo(cwd: string): Promise<Repo | null> {
  const result = await run('git', ['rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir'], {
    cwd,
    timeoutMs: 10_000,
  });
  if (result.code !== 0) return null;

  const [root, commonDir, gitDir] = result.stdout.trim().split('\n');
  if (!root || !commonDir || !gitDir) return null;

  const absolute = (p: string) => (path.isAbsolute(p) ? p : path.resolve(root, p));
  const common = absolute(commonDir);

  return {
    root,
    commonDir: common,
    linkedWorktree: absolute(gitDir) !== common,
  };
}

/** The merge base of two revisions — the `...` of `git diff base...head`. */
export async function mergeBase(repo: Repo, a: string, b: string): Promise<string> {
  const out = await runOk('git', ['merge-base', a, b], { cwd: repo.root, timeoutMs: 10_000 });
  return out.trim();
}

/** The current branch name, or null when HEAD is detached. */
export async function currentBranch(repo: Repo): Promise<string | null> {
  const result = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: repo.root,
    timeoutMs: 10_000,
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Where this review's state belongs. Inside .git, so it never dirties the worktree. */
export function stateDir(repo: Repo): string {
  return path.join(repo.commonDir, 'changestack');
}
