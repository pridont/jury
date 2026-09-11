import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { run } from '../util/exec.js';
import { stateDir, type Repo } from '../git/repo.js';

/** Where review state lived before the extension was called Jury. */
const LEGACY_DIR = 'changestack';
const LEGACY_REFS = 'refs/changestack/';

export type Migration = { movedState: boolean; removedRefs: number };

/**
 * Carry a repository's state across the rename.
 *
 * Marks, notes and cached model answers were stored under the old name — hundreds of cached
 * answers on a large review, which is real money. Moving the directory keeps all of it;
 * starting fresh would throw it away without saying so.
 *
 * When state already exists under the new name, the old directory is left alone rather than
 * merged: two reviews of the same spec cannot be reconciled without guessing which is right.
 */
export async function migrateLegacyState(repo: Repo): Promise<Migration> {
  const legacy = path.join(repo.commonDir, LEGACY_DIR);
  const current = stateDir(repo);

  let movedState = false;
  if ((await exists(legacy)) && !(await exists(current))) {
    await fs.rename(legacy, current);
    movedState = true;
  }

  // Pull request heads fetched under the old name. Only ever written by this extension, and
  // fetched again on demand, so they are ours to remove.
  let removedRefs = 0;
  const listed = await run('git', ['for-each-ref', '--format=%(refname)', LEGACY_REFS], {
    cwd: repo.root,
    timeoutMs: 10_000,
  }).catch(() => null);

  if (listed?.code === 0) {
    for (const ref of listed.stdout.split('\n')) {
      if (!ref.startsWith(LEGACY_REFS)) continue;
      const removed = await run('git', ['update-ref', '-d', ref], { cwd: repo.root, timeoutMs: 10_000 }).catch(
        () => null,
      );
      if (removed?.code === 0) removedRefs += 1;
    }
  }

  return { movedState, removedRefs };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
