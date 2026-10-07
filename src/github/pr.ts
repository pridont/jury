import { run, runOk, type RunOptions, type RunResult } from '../util/exec.js';
import { mergeBase, type Repo } from '../git/repo.js';

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  baseRef: string;
  headOid: string;
  /** owner/repo of the repository the PR targets. */
  nameWithOwner: string;
};

/** The local ref a PR head is fetched into. Nothing is ever checked out. */
export function refFor(number: number): string {
  return `refs/jury/pr-${number}`;
}

/**
 * Resolve a pull request through `gh`, which the user is already authenticated to.
 *
 * With no number, the pull request for the current branch — the common case, and the one
 * where being asked for a number is annoying.
 */
export async function resolve(repo: Repo, number?: number): Promise<PullRequest> {
  const fields = ['number', 'title', 'url', 'baseRefName', 'headRefOid'].join(',');

  const args = ['pr', 'view', ...(number ? [String(number)] : []), '--json', fields];
  const result = await gh(args, { cwd: repo.root, timeoutMs: 30_000 });

  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n')[0] ?? 'gh failed';
    if (/no pull requests found|no default remote/i.test(detail)) {
      throw new Error(number ? `no pull request #${number}` : 'this branch has no pull request');
    }
    throw new Error(detail);
  }

  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  const owner = await nameWithOwner(repo);

  return {
    number: Number(parsed['number']),
    title: String(parsed['title'] ?? ''),
    url: String(parsed['url'] ?? ''),
    baseRef: String(parsed['baseRefName'] ?? 'main'),
    headOid: String(parsed['headRefOid'] ?? ''),
    nameWithOwner: owner,
  };
}

/**
 * Run `gh`, saying plainly when it is not installed. Anything else — a timeout above all — is
 * passed on as it is: "not on PATH" for a request that may well have reached GitHub invites
 * sending it again.
 */
export async function gh(args: string[], options: RunOptions): Promise<RunResult> {
  return run('gh', args, options).catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'ENOENT' ? new Error('gh is not on PATH') : error;
  });
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
  const remote = await remoteFor(repo, pr.nameWithOwner);
  await runOk('git', ['fetch', '--quiet', remote, `pull/${pr.number}/head:${ref}`, '--force'], {
    cwd: repo.root,
    timeoutMs: 120_000,
  });

  // The base branch may not exist locally, and may be stale if it does.
  await run('git', ['fetch', '--quiet', remote, pr.baseRef], { cwd: repo.root, timeoutMs: 120_000 });

  const head = (await runOk('git', ['rev-parse', ref], { cwd: repo.root, timeoutMs: 10_000 })).trim();
  const baseCandidates = [`${remote}/${pr.baseRef}`, pr.baseRef];
  for (const candidate of baseCandidates) {
    const base = await mergeBase(repo, candidate, head).catch(() => null);
    if (base) return { base, head };
  }
  throw new Error(`could not find the merge base of ${pr.baseRef} and #${pr.number}`);
}

/**
 * The remote that points at the repository the pull request is on.
 *
 * In a fork that is usually `upstream`, not `origin` — and fetching `pull/N/head` from the
 * fork gets a different pull request #N, or none. `origin` when nothing matches.
 */
export async function remoteFor(repo: Repo, nameWithOwner: string): Promise<string> {
  if (!nameWithOwner) return 'origin';
  const out = await runOk('git', ['remote', '-v'], { cwd: repo.root, timeoutMs: 10_000 }).catch(() => '');
  const wanted = nameWithOwner.toLowerCase();
  for (const line of out.split('\n')) {
    const [name, url] = line.split(/\s+/);
    // git@github.com:owner/repo.git, https://github.com/owner/repo, ssh://…/owner/repo.git
    const path = url?.toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
    if (name && path && (path.endsWith(`/${wanted}`) || path.endsWith(`:${wanted}`))) return name;
  }
  return 'origin';
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
