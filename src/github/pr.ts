import { run, runOk } from '../util/exec.js';
import { mergeBase, type Repo } from '../git/repo.js';

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  state: string;
  baseRef: string;
  headRef: string;
  headOid: string;
  /** owner/repo of the repository the PR targets. */
  nameWithOwner: string;
  crossRepository: boolean;
};

export class GhError extends Error {
  constructor(
    readonly kind: 'not-installed' | 'not-authenticated' | 'no-pr' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'GhError';
  }
}

/** The local ref a PR head is fetched into. Nothing is ever checked out. */
export function refFor(number: number): string {
  return `refs/changestack/pr-${number}`;
}

/**
 * Resolve a pull request through `gh`, which the user is already authenticated to.
 *
 * With no number, the pull request for the current branch — the common case, and the one
 * where being asked for a number is annoying.
 */
export async function resolve(repo: Repo, number?: number): Promise<PullRequest> {
  const fields = [
    'number',
    'title',
    'url',
    'state',
    'baseRefName',
    'headRefName',
    'headRefOid',
    'isCrossRepository',
  ].join(',');

  const args = ['pr', 'view', ...(number ? [String(number)] : []), '--json', fields];
  const result = await run('gh', args, { cwd: repo.root, timeoutMs: 30_000 }).catch(() => null);

  if (!result) throw new GhError('not-installed', 'gh is not on PATH');
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n')[0] ?? 'gh failed';
    if (/no pull requests found|no default remote/i.test(detail)) {
      throw new GhError('no-pr', number ? `no pull request #${number}` : 'this branch has no pull request');
    }
    if (/auth|login|token/i.test(detail)) throw new GhError('not-authenticated', detail);
    throw new GhError('failed', detail);
  }

  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  const owner = await nameWithOwner(repo);

  return {
    number: Number(parsed['number']),
    title: String(parsed['title'] ?? ''),
    url: String(parsed['url'] ?? ''),
    state: String(parsed['state'] ?? ''),
    baseRef: String(parsed['baseRefName'] ?? 'main'),
    headRef: String(parsed['headRefName'] ?? ''),
    headOid: String(parsed['headRefOid'] ?? ''),
    nameWithOwner: owner,
    crossRepository: parsed['isCrossRepository'] === true,
  };
}

async function nameWithOwner(repo: Repo): Promise<string> {
  const out = await runOk('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    cwd: repo.root,
    timeoutMs: 30_000,
  }).catch(() => '');
  return out.trim();
}

/**
 * Fetch what the author asked to have merged, and nothing else.
 *
 * The head goes into a ref of our own and stays there — no checkout, no branch, nothing
 * touched in the working tree. The comparison is against the **merge base** of the target
 * branch, so the review shows what the pull request introduces rather than a comparison with
 * whatever that branch has done since.
 */
export async function fetchHead(repo: Repo, pr: PullRequest): Promise<{ base: string; head: string }> {
  const ref = refFor(pr.number);
  await runOk('git', ['fetch', '--quiet', 'origin', `pull/${pr.number}/head:${ref}`, '--force'], {
    cwd: repo.root,
    timeoutMs: 120_000,
  });

  // The base branch may not exist locally, and may be stale if it does.
  await run('git', ['fetch', '--quiet', 'origin', pr.baseRef], { cwd: repo.root, timeoutMs: 120_000 });

  const head = (await runOk('git', ['rev-parse', ref], { cwd: repo.root, timeoutMs: 10_000 })).trim();
  const baseCandidates = [`origin/${pr.baseRef}`, pr.baseRef];
  for (const candidate of baseCandidates) {
    const base = await mergeBase(repo, candidate, head).catch(() => null);
    if (base) return { base, head };
  }
  throw new GhError('failed', `could not find the merge base of ${pr.baseRef} and #${pr.number}`);
}

export type PullRequestSummary = {
  number: number;
  title: string;
  author: string;
  headRef: string;
  draft: boolean;
  updatedAt: string;
};

/** Open pull requests, most recently updated first, for picking one without typing a number. */
export async function listOpen(repo: Repo, limit = 30): Promise<PullRequestSummary[]> {
  const result = await run(
    'gh',
    ['pr', 'list', '--limit', String(limit), '--json', 'number,title,author,headRefName,isDraft,updatedAt'],
    { cwd: repo.root, timeoutMs: 30_000 },
  ).catch(() => null);
  if (!result || result.code !== 0) return [];

  try {
    const parsed = JSON.parse(result.stdout) as {
      number?: number;
      title?: string;
      author?: { login?: string };
      headRefName?: string;
      isDraft?: boolean;
      updatedAt?: string;
    }[];

    return parsed
      .filter((entry) => typeof entry.number === 'number')
      .map((entry) => ({
        number: entry.number!,
        title: entry.title ?? '',
        author: entry.author?.login ?? '',
        headRef: entry.headRefName ?? '',
        draft: entry.isDraft === true,
        updatedAt: entry.updatedAt ?? '',
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

/** Which files GitHub already thinks this reviewer has looked at. */
export async function viewedFiles(repo: Repo, pr: PullRequest): Promise<Set<string>> {
  const [owner, name] = pr.nameWithOwner.split('/');
  if (!owner || !name) return new Set();

  const query = `
    query($owner:String!,$repo:String!,$number:Int!,$after:String){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          files(first:100,after:$after){
            pageInfo { hasNextPage endCursor }
            nodes { path viewerViewedState }
          }
        }
      }
    }`;

  const viewed = new Set<string>();
  let after = '';

  for (let page = 0; page < 20; page += 1) {
    const args: string[] = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `repo=${name}`,
      '-F',
      `number=${pr.number}`,
      ...(after ? ['-F', `after=${after}`] : []),
    ];
    const result = await run('gh', args, { cwd: repo.root, timeoutMs: 30_000 }).catch(() => null);
    if (!result || result.code !== 0) return viewed;

    const files = (
      JSON.parse(result.stdout) as {
        data?: {
          repository?: {
            pullRequest?: {
              files?: {
                pageInfo?: { hasNextPage?: boolean; endCursor?: string };
                nodes?: { path?: string; viewerViewedState?: string }[];
              };
            };
          };
        };
      }
    ).data?.repository?.pullRequest?.files;

    for (const node of files?.nodes ?? []) {
      if (node.viewerViewedState === 'VIEWED' && node.path) viewed.add(node.path);
    }

    if (!files?.pageInfo?.hasNextPage || !files.pageInfo.endCursor) break;
    after = files.pageInfo.endCursor;
    /* c8 ignore next */
  }

  return viewed;
}
