import { gh, type PullRequest } from './pr.js';
import type { Repo } from '../git/repo.js';
import type { FileChange } from '../git/parse.js';
import { commentOffset, hunkAt } from '../model/comments.js';

/** A review comment someone left on the pull request, as GitHub reports it. */
export type RemoteComment = {
  id: number;
  /** The first comment of the thread this one answers. GitHub always points at the root. */
  replyTo: number | null;
  /** The review it was posted in, which is how Jury recognises its own. */
  reviewId: number | null;
  path: string;
  /** Null once the code it was on has changed: GitHub calls the comment outdated. */
  line: number | null;
  side: 'LEFT' | 'RIGHT';
  author: string;
  body: string;
};

/** Comments that read as one conversation, placed on a hunk the way a note is. */
export type RemoteThread = {
  hunkId: string;
  offset: number;
  side: 'old' | 'new';
  comments: RemoteComment[];
};

/**
 * Every inline comment on the pull request, from everyone.
 *
 * `--jq '.[]'` prints one comment per line however many pages there are, where bare
 * `--paginate` prints each page's array back to back — not one JSON document.
 */
export async function reviewComments(repo: Repo, pr: PullRequest): Promise<RemoteComment[]> {
  const result = await gh(
    ['api', '--paginate', `repos/${pr.nameWithOwner}/pulls/${pr.number}/comments`, '--jq', '.[]'],
    { cwd: repo.root, timeoutMs: 60_000 },
  );
  if (result.code !== 0) throw new Error(result.stderr.trim().split('\n')[0] || 'gh failed');
  return parseReviewComments(result.stdout);
}

export function parseReviewComments(out: string): RemoteComment[] {
  return out
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const raw = JSON.parse(line) as {
        id?: number;
        in_reply_to_id?: number;
        pull_request_review_id?: number | null;
        path?: string;
        line?: number | null;
        side?: string;
        user?: { login?: string } | null;
        body?: string;
      };
      return {
        id: Number(raw.id),
        replyTo: raw.in_reply_to_id ?? null,
        reviewId: raw.pull_request_review_id ?? null,
        path: raw.path ?? '',
        line: raw.line ?? null,
        side: raw.side === 'LEFT' ? ('LEFT' as const) : ('RIGHT' as const),
        author: raw.user?.login ?? 'unknown',
        body: raw.body ?? '',
      };
    });
}

/**
 * Put other people's comments on the hunks they were left on.
 *
 * Comments from a review Jury posted are left out: the reviewer's own note is already on
 * screen, and a second copy of it under their GitHub name would look like someone agreeing.
 * A reply to one of those is still someone else's, so it stays, as a thread of its own.
 *
 * Outdated comments, and comments on lines this diff does not show, are not placed — there
 * is nowhere true to put them, and the pull request page still has them.
 */
export function placeRemote(
  comments: readonly RemoteComment[],
  files: readonly FileChange[],
  ownReviews: ReadonlySet<number>,
): RemoteThread[] {
  const threads = new Map<number, RemoteComment[]>();
  for (const comment of comments) {
    if (comment.reviewId !== null && ownReviews.has(comment.reviewId)) continue;
    const root = comment.replyTo ?? comment.id;
    threads.set(root, [...(threads.get(root) ?? []), comment]);
  }

  const placed: RemoteThread[] = [];
  for (const thread of threads.values()) {
    const first = thread[0]!;
    if (first.line === null) continue;

    const side = first.side === 'LEFT' ? 'old' : 'new';
    const file = files.find((candidate) => candidate.path === first.path);
    const hunk = file ? hunkAt(file.hunks, side, first.line) : null;
    if (!hunk || hunk.kind !== 'text') continue;

    placed.push({ hunkId: hunk.id, offset: commentOffset(hunk, side, first.line), side, comments: thread });
  }
  return placed;
}
