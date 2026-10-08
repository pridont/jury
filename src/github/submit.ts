import { createHash } from 'node:crypto';
import { gh } from './pr.js';
import type { Repo } from '../git/repo.js';
import type { Comment, Hunk } from '../model/types.js';
import { commentLine } from '../model/comments.js';
import type { PullRequest } from './pr.js';

/**
 * `PENDING` is not an event GitHub knows: it is sending none, which leaves the review as a
 * draft only the reviewer can see, to finish and submit on the web.
 */
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' | 'PENDING';

export type InlineComment = {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  /** Which stored note this came from, so a successful post can be recorded against it. */
  commentId: string;
};

/** What was actually sent, so the same note is not sent twice. */
export function bodyHash(body: string): string {
  return createHash('sha1').update(body).digest('hex').slice(0, 16);
}

export type Submission = {
  event: ReviewEvent;
  body: string;
  comments: InlineComment[];
  /** Notes that could not be placed, and so are not being sent. */
  skipped: { body: string; reason: string }[];
};

/**
 * Turn the review into what GitHub will accept.
 *
 * Positions use `line` + `side` rather than the diff-`position` arithmetic GitHub's older
 * API wanted: position counts lines within the diff hunk and is wrong the moment anything
 * about the diff differs from what was posted against.
 *
 * A note the tool is only guessing the position of is still sent — losing it would be worse
 * — but says so in its own text, so nobody on the other end mistakes a guess for a fact. A
 * note whose code is gone is not sent at all, and is reported rather than dropped silently.
 */
export function prepare(
  comments: readonly Comment[],
  hunks: ReadonlyMap<string, Hunk>,
  event: ReviewEvent,
  body: string,
): Submission {
  const inline: InlineComment[] = [];
  const skipped: { body: string; reason: string }[] = [];

  for (const comment of comments) {
    if (comment.posted && comment.posted.bodyHash === bodyHash(comment.body)) {
      // Already on the pull request, unchanged. Posting it again would put a second copy in
      // front of the author, who has no way to tell it is the same note.
      skipped.push({ body: comment.body, reason: 'already posted, and unchanged since' });
      continue;
    }
    if (comment.orphaned) {
      skipped.push({ body: comment.body, reason: 'the code it was about is no longer in the diff' });
      continue;
    }
    const hunk = hunks.get(comment.hunkId);
    if (!hunk) {
      skipped.push({ body: comment.body, reason: 'its hunk is not in this diff' });
      continue;
    }
    if (hunk.kind !== 'text') {
      skipped.push({ body: comment.body, reason: `GitHub cannot place a comment on a ${hunk.kind} change` });
      continue;
    }

    // A note that moved keeps its old offset, which a shorter hunk may no longer reach. One
    // line GitHub cannot place fails the whole review, so pull it back inside the hunk.
    const count = comment.side === 'new' ? hunk.newCount : hunk.oldCount;
    if (count === 0) {
      skipped.push({ body: comment.body, reason: `its hunk has no ${comment.side} lines to attach it to` });
      continue;
    }
    const offset = Math.min(comment.offset, count - 1);

    inline.push({
      path: hunk.path,
      line: commentLine(hunk, { side: comment.side, offset }),
      side: comment.side === 'old' ? 'LEFT' : 'RIGHT',
      body:
        comment.moved || offset !== comment.offset
          ? `${comment.body}\n\n_(position is approximate — the code moved since this was written)_`
          : comment.body,
      commentId: comment.id,
    });
  }

  return { event, body, comments: inline, skipped };
}

/** What the user is shown before anything leaves the machine. */
export function preview(pr: PullRequest, submission: Submission): string {
  const lines = [
    `${verb(submission.event)} ${pr.nameWithOwner}#${pr.number} — ${pr.title}`,
    '',
    submission.body || '(no summary)',
    '',
    `${submission.comments.length} inline comment${submission.comments.length === 1 ? '' : 's'}:`,
  ];

  for (const comment of submission.comments) {
    lines.push(`  ${comment.path}:${comment.line} (${comment.side})`);
    lines.push(`    ${comment.body.split('\n')[0] ?? ''}`);
  }

  if (submission.skipped.length > 0) {
    lines.push('', `${submission.skipped.length} not sent:`);
    for (const note of submission.skipped) {
      lines.push(`  ${note.body.split('\n')[0] ?? ''} — ${note.reason}`);
    }
  }

  return lines.join('\n');
}

function verb(event: ReviewEvent): string {
  if (event === 'PENDING') return 'Draft review (pending, not submitted) on';
  return event === 'APPROVE' ? 'Approve' : event === 'REQUEST_CHANGES' ? 'Request changes on' : 'Comment on';
}

/**
 * Send the review.
 *
 * The whole payload goes as one JSON body on stdin rather than as repeated `-f` flags:
 * comment bodies are arbitrary text, and shell-shaped argument building is how a comment
 * containing a quote turns into a malformed request.
 */
export async function submit(
  repo: Repo,
  pr: PullRequest,
  submission: Submission,
): Promise<{ url: string; reviewId: number }> {
  const result = await gh(
    ['api', '--method', 'POST', `repos/${pr.nameWithOwner}/pulls/${pr.number}/reviews`, '--input', '-'],
    { cwd: repo.root, stdin: JSON.stringify(payload(pr, submission)), timeoutMs: 60_000 },
  );

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(0, 3).join(' ');
    throw new Error(detail);
  }

  const parsed = JSON.parse(result.stdout) as { html_url?: string; id?: number };
  return { url: parsed.html_url ?? pr.url, reviewId: Number(parsed.id ?? 0) };
}

/** The request body. A draft sends no `event` at all, which is what keeps it pending. */
export function payload(pr: PullRequest, submission: Submission): Record<string, unknown> {
  return {
    commit_id: pr.headOid,
    body: submission.body,
    ...(submission.event === 'PENDING' ? {} : { event: submission.event }),
    comments: submission.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body,
    })),
  };
}

/**
 * Record what was posted, so the next submission does not send it again.
 *
 * A draft counts: its comments are on GitHub, waiting in the reviewer's pending review, and
 * sending them again would put a second copy in the same draft.
 */
export function recordPosted(comments: Comment[], submission: Submission, reviewId: number): void {
  const sent = new Map(submission.comments.map((comment) => [comment.commentId, comment.body]));
  const at = Date.now();

  for (const comment of comments) {
    const body = sent.get(comment.id);
    if (body === undefined) continue;
    comment.posted = { reviewId, bodyHash: bodyHash(comment.body), at };
  }
}
