import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import type { Api } from '../../src/extension.js';
import type { PullRequest } from '../../src/github/pr.js';
import { parseReviewComments } from '../../src/github/comments.js';
import { answerModal, fake, pick, repo, review, waitFor } from './harness.js';

const BASE = {
  'README.md': '# fixture\n',
  'src/token.ts': 'export function expired(at: number, now: number): boolean {\n  return at < now;\n}\n',
};

const PR: PullRequest = {
  id: 'PR_kwDO',
  number: 141,
  title: 'feat: tokens',
  url: 'https://github.com/o/r/pull/141',
  baseRef: 'main',
  headOid: '',
  nameWithOwner: 'o/r',
};

/** A review comment as GitHub's REST API returns it, on line 2 of `src/token.ts`. */
const comment = (head: string, fields: Record<string, unknown>) => ({
  path: 'src/token.ts',
  line: 2,
  commit_id: head,
  original_line: 2,
  original_commit_id: head,
  side: 'RIGHT',
  ...fields,
});

/**
 * Treat the open working tree review as a pull request, with what `remote` returns as other
 * reviewers' comments on it. Fetching a real pull request needs a real GitHub; what these
 * tests check starts once the review has its comments.
 */
function asPullRequest(api: Api, remote: (head: string) => Record<string, unknown>[] = () => []): void {
  const session = api.host.active!;
  session.pr = { ...PR, headOid: session.head };
  session.remoteComments = parseReviewComments(
    remote(session.head)
      .map((raw) => JSON.stringify(raw))
      .join('\n'),
  );
  api.comments.renderRemote();
}

/** The other reviewers' threads on screen, with the GitHub comment each one answers. */
function remoteThreads(api: Api): Map<vscode.CommentThread, number> {
  return (api.comments as unknown as { remote: Map<vscode.CommentThread, number> }).remote;
}

suite('github', () => {
  // These tests post reviews and replies. With the real gh they would go to GitHub.
  suiteSetup(() => {
    assert.match(execFileSync('gh', ['--version'], { encoding: 'utf8' }), /fake gh/, 'gh on PATH is not the fake one');
  });

  setup(async () => {
    fake.reset();
    await repo.reset(BASE);
    repo.write({ 'src/token.ts': 'export function expired(at: number, now: number): boolean {\n  return at <= now;\n}\n' });
  });

  test("a reply to another reviewer's thread is confirmed, sent to its first comment, and shown in it", async () => {
    const api = await review();
    const head = api.host.active!.head;
    asPullRequest(api, () => [
      comment(head, { id: 7, user: { login: 'mona' }, body: 'Why <=?' }),
      comment(head, { id: 9, in_reply_to_id: 7, user: { login: 'hubot' }, body: 'Same question.' }),
    ]);
    const [thread, root] = [...remoteThreads(api)][0]!;
    assert.equal(root, 7);
    assert.equal(thread.contextValue, 'remote');
    assert.equal(thread.comments.length, 2);

    fake.gh(
      'comments/7/replies',
      JSON.stringify(comment(head, { id: 10, in_reply_to_id: 7, user: { login: 'me' }, body: 'Expiry is inclusive.' })),
    );
    const asked = answerModal('Reply');
    await vscode.commands.executeCommand('jury.replyOnGitHub', { thread, text: 'Expiry is inclusive.' });

    assert.equal(asked[0], 'Reply on o/r#141?');
    assert.match(asked[1]!, /Expiry is inclusive\./);

    const calls = fake.ghCalls().filter((call) => call.args.some((arg) => arg.endsWith('/replies')));
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.args.includes('repos/o/r/pulls/141/comments/7/replies'));
    assert.deepEqual(JSON.parse(calls[0]!.input), { body: 'Expiry is inclusive.' });

    const [shown] = [...remoteThreads(api)].find(([, id]) => id === 7)!;
    assert.deepEqual(
      shown.comments.map((c) => [c.author.name, typeof c.body === 'string' ? c.body : c.body.value]),
      [
        ['mona', 'Why <=?'],
        ['hubot', 'Same question.'],
        ['me', 'Expiry is inclusive.'],
      ],
    );
    assert.equal(shown.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    // A reply is GitHub's, not a note of the reviewer's: nothing to export or post again.
    assert.equal(api.host.active?.comments.length, 0);
  });

  test('cancelling the reply sends nothing', async () => {
    const api = await review();
    asPullRequest(api, (head) => [comment(head, { id: 7, user: { login: 'mona' }, body: 'Why <=?' })]);
    const [thread] = [...remoteThreads(api)][0]!;

    const asked = answerModal(undefined);
    await vscode.commands.executeCommand('jury.replyOnGitHub', { thread, text: 'Never mind.' });

    assert.equal(asked.length, 2);
    assert.equal(fake.ghCalls().filter((call) => call.args.some((arg) => arg.endsWith('/replies'))).length, 0);
    assert.equal([...remoteThreads(api)][0]![0].comments.length, 1);
  });

  test('a reply GitHub refuses is not shown as sent', async () => {
    const api = await review();
    asPullRequest(api, (head) => [comment(head, { id: 7, user: { login: 'mona' }, body: 'Why <=?' })]);
    const [thread] = [...remoteThreads(api)][0]!;

    // Nothing scripted for the replies endpoint, so the fake gh fails it. The error message
    // waits for a click that never comes, so the command is not awaited.
    answerModal('Reply');
    void vscode.commands.executeCommand('jury.replyOnGitHub', { thread, text: 'Expiry is inclusive.' });
    await waitFor(() => fake.ghCalls().some((call) => call.args.some((arg) => arg.endsWith('/replies'))), 'the reply to be sent');
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal([...remoteThreads(api)][0]![0].comments.length, 1);
    assert.equal(api.host.active?.remoteComments.length, 1);
  });

  test('suggest a change starts a note holding the line as a GitHub suggestion', async () => {
    const api = await review();
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(`${repo.root}/src/token.ts`));
    editor.selection = new vscode.Selection(1, 4, 1, 4);

    await vscode.commands.executeCommand('jury.suggestChange');

    const [note] = api.host.active!.comments;
    assert.equal(note?.body, '```suggestion\n  return at <= now;\n```');
    assert.equal(note?.side, 'new');
    assert.equal(note?.offset, 1);
  });

  test('suggest a change does nothing outside the change', async () => {
    const api = await review();
    await vscode.window.showTextDocument(vscode.Uri.file(`${repo.root}/README.md`));

    await vscode.commands.executeCommand('jury.suggestChange');

    assert.equal(api.host.active?.comments.length, 0);
  });

  test('a suggested change is submitted to GitHub as one', async () => {
    const api = await review();
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(`${repo.root}/src/token.ts`));
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    await vscode.commands.executeCommand('jury.suggestChange');
    const note = api.host.active!.comments[0]!;
    note.body = note.body.replace('<=', '<');
    // Done editing: the note's open editor would otherwise take focus from the submit picker.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    asPullRequest(api);
    const session = api.host.active!;
    session.spec = { kind: 'pr', number: PR.number, base: session.base, head: session.head, title: PR.title };
    fake.gh('pulls/141/reviews', JSON.stringify({ id: 55, html_url: PR.url }));

    // The summary box cannot be typed into headless; answer it empty, as a skipped summary.
    const window = vscode.window as { showInputBox: typeof vscode.window.showInputBox };
    const showInputBox = window.showInputBox;
    window.showInputBox = async () => '';
    let sent;
    try {
      answerModal('Send');
      void vscode.commands.executeCommand('jury.submitReview');
      await pick(0); // Comment
      sent = await waitFor(
        () => fake.ghCalls().find((call) => call.args.some((arg) => arg.endsWith('/pulls/141/reviews'))),
        'the review to be sent',
      );
    } finally {
      window.showInputBox = showInputBox;
    }

    const payload = JSON.parse(sent.input) as { comments: { path: string; line: number; side: string; body: string }[] };
    assert.deepEqual(payload.comments, [
      { path: 'src/token.ts', line: 2, side: 'RIGHT', body: '```suggestion\n  return at < now;\n```' },
    ]);
  });
});
