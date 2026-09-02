import { run } from '../util/exec.js';
import type { Repo } from './repo.js';

/**
 * Ask git what the repository's own `.gitattributes` say about these paths.
 *
 * Reading and matching `.gitattributes` by hand would mean reimplementing git's precedence
 * rules; `check-attr` already knows them, including per-directory files and the user's
 * global attributes.
 */
export async function checkAttributes(repo: Repo, paths: readonly string[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (paths.length === 0) return result;

  const output = await run('git', ['check-attr', '-z', '--stdin', 'linguist-generated', 'diff'], {
    cwd: repo.root,
    stdin: paths.join('\0'),
    timeoutMs: 30_000,
  }).catch(() => null);
  if (!output || output.code !== 0) return result;

  const fields = output.stdout.split('\0');
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i]!;
    const attribute = fields[i + 1]!;
    const value = fields[i + 2]!;

    const set = result.get(path) ?? new Set<string>();
    // `linguist-generated` gives "set"; `linguist-generated=true` gives the string "true".
    // Both are the repository saying the same thing.
    if (attribute === 'linguist-generated' && (value === 'set' || value === 'true')) {
      set.add('linguist-generated');
    }
    if (attribute === 'diff' && value === 'unset') set.add('no-diff');
    if (set.size > 0) result.set(path, set);
  }

  return result;
}
