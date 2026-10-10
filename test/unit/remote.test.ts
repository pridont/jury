import { describe, expect, it } from 'vitest';
import { parseReviewComments, placeRemote, type RemoteComment } from '../../src/github/comments.js';
import type { FileChange } from '../../src/git/parse.js';
import type { Hunk } from '../../src/model/types.js';

const hunk = (id: string, path: string, start: number, kind: Hunk['kind'] = 'text'): Hunk => ({
  id,
  path,
  oldStart: start,
  oldCount: 3,
  newStart: start + 10,
  newCount: 3,
  lines: [' ctx', '-old', '+new', ' ctx'],
  stats: { added: 1, removed: 1 },
  kind,
});

const files: FileChange[] = [
  {
    path: 'src/auth.ts',
    status: 'modified',
    binary: false,
    hunks: [hunk('h1', 'src/auth.ts', 40)],
    stats: { added: 1, removed: 1 },
  },
];

const remote = (overrides: Partial<RemoteComment>): RemoteComment => ({
  id: 1,
  replyTo: null,
  reviewId: 100,
  path: 'src/auth.ts',
  line: 51,
  commit: 'head',
  originalLine: 51,
  originalCommit: 'head',
  side: 'RIGHT',
  author: 'octocat',
  body: 'why?',
  ...overrides,
});

describe('parseReviewComments', () => {
  it('reads one comment per line, as gh prints them with --jq', () => {
    const out = [
      JSON.stringify({
        id: 7,
        pull_request_review_id: 3,
        path: 'a.ts',
        line: 12,
        commit_id: 'c2',
        original_line: 10,
        original_commit_id: 'c1',
        side: 'LEFT',
        user: { login: 'mona' },
        body: 'two\nlines',
      }),
      JSON.stringify({ id: 8, in_reply_to_id: 7, pull_request_review_id: 4, path: 'a.ts', line: null, side: 'RIGHT' }),
      '',
    ].join('\n');

    expect(parseReviewComments(out)).toEqual([
      {
        id: 7,
        replyTo: null,
        reviewId: 3,
        path: 'a.ts',
        line: 12,
        commit: 'c2',
        originalLine: 10,
        originalCommit: 'c1',
        side: 'LEFT',
        author: 'mona',
        body: 'two\nlines',
      },
      {
        id: 8,
        replyTo: 7,
        reviewId: 4,
        path: 'a.ts',
        line: null,
        commit: '',
        originalLine: null,
        originalCommit: '',
        side: 'RIGHT',
        author: 'unknown',
        body: '',
      },
    ]);
  });
});

describe('placeRemote', () => {
  it('puts a comment on the hunk and offset its line falls in', () => {
    expect(placeRemote([remote({})], files, new Set(), 'head')).toEqual([
      { hunkId: 'h1', offset: 1, side: 'new', comments: [remote({})] },
    ]);
  });

  it('reads LEFT against the old side', () => {
    const [thread] = placeRemote([remote({ side: 'LEFT', line: 42 })], files, new Set(), 'head');
    expect(thread).toMatchObject({ hunkId: 'h1', offset: 2, side: 'old' });
  });

  it('places by the line on the head that was read, not the pull request head now', () => {
    const moved = remote({ commit: 'newer', line: 99, originalCommit: 'head', originalLine: 51 });
    expect(placeRemote([moved], files, new Set(), 'head')).toMatchObject([{ hunkId: 'h1', offset: 1 }]);
    const elsewhere = remote({ commit: 'newer', originalCommit: 'older' });
    expect(placeRemote([elsewhere], files, new Set(), 'head')).toEqual([]);
  });

  it('skips outdated comments and lines outside the diff', () => {
    const comments = [remote({ id: 1, line: null }), remote({ id: 2, line: 99 }), remote({ id: 3, path: 'other.ts' })];
    expect(placeRemote(comments, files, new Set(), 'head')).toEqual([]);
  });

  it('groups replies into the thread they answer', () => {
    const reply = remote({ id: 2, replyTo: 1, body: 'because', author: 'mona' });
    const threads = placeRemote([remote({}), reply], files, new Set(), 'head');
    expect(threads).toHaveLength(1);
    expect(threads[0]!.comments.map((c) => c.body)).toEqual(['why?', 'because']);
  });

  it('leaves out what Jury posted, but keeps replies to it', () => {
    const own = remote({ id: 1, reviewId: 5 });
    const reply = remote({ id: 2, replyTo: 1, reviewId: 6, body: 'fixed' });
    const threads = placeRemote([own, reply], files, new Set([5]), 'head');
    expect(threads).toHaveLength(1);
    expect(threads[0]!.comments).toEqual([reply]);
  });
});
