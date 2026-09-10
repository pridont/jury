import { run } from '../util/exec.js';
import type { Repo } from './repo.js';

export type RefKind = 'branch' | 'remote' | 'tag' | 'commit';

export type Ref = {
  name: string;
  kind: RefKind;
  /** Relative date, so "8 weeks ago" answers "is this the one I mean". */
  when: string;
  subject: string;
};

/** Unit separator: a branch subject can contain anything a tab or a pipe could. */
const SEP = '\u001f';

/**
 * Every ref worth offering, most recently touched first.
 *
 * Ordering by commit date rather than alphabetically is the whole value: the branch someone
 * wants to diff against is nearly always one of the last few they touched, and an
 * alphabetical list buries it among tags from two years ago.
 */
export async function listRefs(repo: Repo, limit = 60): Promise<Ref[]> {
  const result = await run(
    'git',
    [
      'for-each-ref',
      '--sort=-committerdate',
      `--count=${limit}`,
      `--format=%(refname:short)${SEP}%(refname)${SEP}%(committerdate:relative)${SEP}%(subject)`,
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ],
    { cwd: repo.root, timeoutMs: 15_000 },
  ).catch(() => null);
  if (!result || result.code !== 0) return [];

  const refs: Ref[] = [];
  for (const line of result.stdout.split('\n')) {
    const [name, full, when, subject] = line.split(SEP);
    if (!name || !full) continue;
    // Our own PR refs are machinery, not something to offer as a review target.
    if (full.startsWith('refs/changestack/')) continue;
    if (name.endsWith('/HEAD')) continue;

    refs.push({
      name,
      kind: full.startsWith('refs/tags/') ? 'tag' : full.startsWith('refs/remotes/') ? 'remote' : 'branch',
      when: when ?? '',
      subject: subject ?? '',
    });
  }
  return refs;
}

/** Recent commits, for reviewing against a point rather than a branch. */
export async function recentCommits(repo: Repo, limit = 20): Promise<Ref[]> {
  const result = await run('git', ['log', `-${limit}`, `--format=%h${SEP}%cr${SEP}%s`], {
    cwd: repo.root,
    timeoutMs: 15_000,
  }).catch(() => null);
  if (!result || result.code !== 0) return [];

  return result.stdout
    .split('\n')
    .map((line) => line.split(SEP))
    .filter(([hash]) => Boolean(hash))
    .map(([hash, when, subject]) => ({
      name: hash!,
      kind: 'commit' as const,
      when: when ?? '',
      subject: subject ?? '',
    }));
}

/** What this repository considers its trunk, so it can be offered first. */
export async function defaultBranch(repo: Repo): Promise<string | null> {
  const head = await run('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
    cwd: repo.root,
    timeoutMs: 10_000,
  }).catch(() => null);

  if (head?.code === 0) {
    const name = head.stdout.trim().replace('refs/remotes/', '');
    if (name) return name;
  }

  for (const candidate of ['main', 'master', 'develop']) {
    const exists = await run('git', ['rev-parse', '--verify', '--quiet', candidate], {
      cwd: repo.root,
      timeoutMs: 10_000,
    }).catch(() => null);
    if (exists?.code === 0) return candidate;
  }
  return null;
}
