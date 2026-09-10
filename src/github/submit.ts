import { run } from '../util/exec.js';
import type { Repo } from '../git/repo.js';
import type { Comment, Hunk } from '../model/types.js';
import { commentLine } from '../model/comments.js';
import { GhError, type PullRequest } from './pr.js';

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export type InlineComment = {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
};

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

    inline.push({
      path: hunk.path,
      line: commentLine(hunk, comment),
      side: comment.side === 'old' ? 'LEFT' : 'RIGHT',
      body: comment.moved ? `${comment.body}\n\n_(position is approximate — the code moved since this was written)_` : comment.body,
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
  return event === 'APPROVE' ? 'Approve' : event === 'REQUEST_CHANGES' ? 'Request changes on' : 'Comment on';
}

/**
 * Send the review.
 *
 * The whole payload goes as one JSON body on stdin rather than as repeated `-f` flags:
 * comment bodies are arbitrary text, and shell-shaped argument building is how a comment
 * containing a quote turns into a malformed request.
 */
export async function submit(repo: Repo, pr: PullRequest, submission: Submission): Promise<string> {
  const payload = {
    commit_id: pr.headOid,
    body: submission.body,
    event: submission.event,
    comments: submission.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body,
    })),
  };

  const result = await run(
    'gh',
    ['api', '--method', 'POST', `repos/${pr.nameWithOwner}/pulls/${pr.number}/reviews`, '--input', '-'],
    { cwd: repo.root, stdin: JSON.stringify(payload), timeoutMs: 60_000 },
  ).catch(() => null);

  if (!result) throw new GhError('not-installed', 'gh is not on PATH');
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(0, 3).join(' ');
    throw new GhError(/auth|login|token/i.test(detail) ? 'not-authenticated' : 'failed', detail);
  }

  const parsed = JSON.parse(result.stdout) as { html_url?: string };
  return parsed.html_url ?? pr.url;
}
