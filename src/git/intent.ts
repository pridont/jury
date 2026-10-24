import { prDescription } from '../github/pr.js';
import type { ReviewSpec } from '../model/types.js';
import { run } from '../util/exec.js';
import type { Repo } from './repo.js';

/** Past this, what the author wrote crowds out the change it describes. */
const MAX_CHARS = 6000;

/** Record separator: a commit message can contain anything else. */
const SEP = '\u001e';

/**
 * What the author says the change does: the pull request's description and the commit
 * messages, oldest first. Empty for uncommitted work, which has neither.
 *
 * Best effort. A missing `gh` or a failed `git log` costs the model some context, never the
 * review.
 */
export async function authorIntent(repo: Repo, spec: ReviewSpec, base: string, head: string): Promise<string> {
  if (spec.kind === 'worktree' || spec.kind === 'staged') return '';

  const [description, commits] = await Promise.all([
    spec.kind === 'pr' ? prDescription(repo, spec.number).catch(() => '') : Promise.resolve(''),
    commitMessages(repo, spec.kind === 'commit' ? ['-1', spec.sha] : [`${base}..${head}`]),
  ]);

  const parts: string[] = [];
  if (spec.kind === 'pr') {
    parts.push(`Pull request: ${spec.title ?? `#${spec.number}`}`);
    if (description) parts.push(description);
  }
  if (commits.length > 0) {
    parts.push(
      `Commits, oldest first:\n` +
        commits.map((message) => `- ${message.replace(/\n/g, '\n  ')}`).join('\n'),
    );
  }

  const text = parts.join('\n\n');
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n… (cut short)`;
}

async function commitMessages(repo: Repo, range: string[]): Promise<string[]> {
  const result = await run('git', ['log', '--no-merges', '--reverse', `--format=${SEP}%B`, ...range, '--'], {
    cwd: repo.root,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!result || result.code !== 0) return [];
  return result.stdout
    .split(SEP)
    .map((message) => message.trim())
    .filter(Boolean);
}
