import { describe, expect, it } from 'vitest';
import { prepare, preview } from '../../src/github/submit.js';
import { newComment } from '../../src/model/comments.js';
import type { Hunk } from '../../src/model/types.js';
import type { PullRequest } from '../../src/github/pr.js';

const hunk = (id: string, path: string, newStart: number, kind: Hunk['kind'] = 'text'): Hunk => ({
  id,
  path,
  oldStart: newStart,
  oldCount: 3,
  newStart,
  newCount: 3,
  lines: [' ctx', '-old', '+new'],
  stats: { added: 1, removed: 1 },
  kind,
});

const hunks = new Map<string, Hunk>([
  ['h1', hunk('h1', 'src/auth.ts', 40)],
  ['h2', hunk('h2', 'logo.png', 0, 'binary')],
]);

const pr: PullRequest = {
  number: 141,
  title: 'feat: course viewer',
  url: 'https://github.com/o/r/pull/141',
  state: 'OPEN',
  baseRef: 'main',
  headRef: 'feat/x',
  headOid: 'a'.repeat(40),
  nameWithOwner: 'o/r',
  crossRepository: false,
};

describe('prepare', () => {
  it('places a note with line and side, not a diff position', () => {
    const note = newComment('h1', 2, 'new', 'off by one?');
    const { comments } = prepare([note], hunks, 'COMMENT', '');

    expect(comments).toEqual([
      { path: 'src/auth.ts', line: 42, side: 'RIGHT', body: 'off by one?' },
    ]);
  });

  it('sends a note on the old side as LEFT', () => {
    const note = newComment('h1', 0, 'old', 'why was this removed?');
    expect(prepare([note], hunks, 'COMMENT', '').comments[0]!.side).toBe('LEFT');
  });

  it('sends a moved note, but says the position is a guess', () => {
    const note = { ...newComment('h1', 1, 'new', 'still true?'), moved: true };
    const [comment] = prepare([note], hunks, 'COMMENT', '').comments;

    expect(comment!.body).toContain('still true?');
    expect(comment!.body).toContain('position is approximate');
  });

  it('does not send an orphaned note, and says why', () => {
    const note = { ...newComment('h1', 0, 'new', 'what happened here?'), orphaned: true };
    const { comments, skipped } = prepare([note], hunks, 'COMMENT', '');

    expect(comments).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ reason: 'the code it was about is no longer in the diff' });
  });

  it('does not try to comment on a binary change', () => {
    const note = newComment('h2', 0, 'new', 'is this the right asset?');
    const { comments, skipped } = prepare([note], hunks, 'COMMENT', '');

    expect(comments).toHaveLength(0);
    expect(skipped[0]!.reason).toContain('binary');
  });

  it('skips a note whose hunk is not in this diff at all', () => {
    const note = newComment('gone', 0, 'new', 'stale');
    expect(prepare([note], hunks, 'COMMENT', '').skipped).toHaveLength(1);
  });

  it('carries the event and the summary through', () => {
    const { event, body } = prepare([], hunks, 'REQUEST_CHANGES', 'Two things to fix.');
    expect({ event, body }).toEqual({ event: 'REQUEST_CHANGES', body: 'Two things to fix.' });
  });
});

describe('preview', () => {
  it('shows what will be sent, and what will not', () => {
    const notes = [
      newComment('h1', 2, 'new', 'off by one?'),
      { ...newComment('h1', 0, 'new', 'vanished'), orphaned: true },
    ];
    const text = preview(pr, prepare(notes, hunks, 'REQUEST_CHANGES', 'Please look again.'));

    expect(text).toContain('Request changes on o/r#141');
    expect(text).toContain('Please look again.');
    expect(text).toContain('src/auth.ts:42 (RIGHT)');
    expect(text).toContain('off by one?');
    expect(text).toContain('1 not sent:');
    expect(text).toContain('vanished');
  });

  it('names the action for each event', () => {
    for (const [event, verb] of [
      ['APPROVE', 'Approve'],
      ['COMMENT', 'Comment on'],
      ['REQUEST_CHANGES', 'Request changes on'],
    ] as const) {
      expect(preview(pr, prepare([], hunks, event, ''))).toContain(verb);
    }
  });

  it('is honest about an empty review', () => {
    const text = preview(pr, prepare([], hunks, 'APPROVE', ''));
    expect(text).toContain('(no summary)');
    expect(text).toContain('0 inline comments');
  });
});
