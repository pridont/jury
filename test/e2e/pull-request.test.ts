import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Session } from '../../src/session.js';
import { configure, dialogs, documentText, fake, gh, jury, pick, repo, review, waitFor } from './harness.js';

const BASE = {
  'src/clock.ts': 'export function now(): number {\n  return Date.now();\n}\n',
  'src/token.ts': 'export function expired(at: number, now: number): boolean {\n  return at < now;\n}\n',
};
const CHANGE = {
  'src/clock.ts': 'export function now(): number {\n  return Math.floor(Date.now() / 1000);\n}\n',
  'src/token.ts': 'export function expired(at: number, now: number): boolean {\n  return at <= now;\n}\n',
};

const PR = 7;
const TITLE = 'Fix token expiry';
const origin = () => path.join(fake.dir, 'origin.git');

type Remote = { id: number; in_reply_to_id?: number; path: string; line: number; user: { login: string }; body: string };

/**
 * A repository with an `origin` that has pull request #7 at `refs/pull/7/head`, the way
 * GitHub serves it, checked out on the pull request's branch. `main` has moved on since the
 * branch was cut. `gh` is scripted to describe it, with `viewed` files already ticked on the
 * web and `comments` from other reviewers. Returns the head commit.
 */
async function pullRequest(options: { viewed?: string[]; comments?: Remote[] } = {}): Promise<string> {
  fake.reset();
  await repo.reset(BASE);
  fs.rmSync(origin(), { recursive: true, force: true });
  repo.git('init', '-q', '--bare', origin());
  repo.git('remote', 'add', 'origin', origin());

  repo.git('checkout', '-q', '-b', 'fix-expiry');
  repo.write(CHANGE);
  repo.commit('fix expiry');
  const head = repo.git('rev-parse', 'HEAD').trim();
  repo.git('push', '-q', 'origin', `HEAD:refs/pull/${PR}/head`);

  repo.git('checkout', '-q', 'main');
  repo.write({ 'src/later.ts': 'later\n' });
  repo.commit('main moves on');
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', 'fix-expiry');

  gh.reply('^repo view', 'acme/widgets\n');
  gh.reply(
    `^pr view ${PR} `,
    JSON.stringify({
      id: 'PR_7',
      number: PR,
      title: TITLE,
      url: `https://github.com/acme/widgets/pull/${PR}`,
      baseRefName: 'main',
      headRefOid: head,
    }),
  );
  gh.reply(
    '^pr list',
    JSON.stringify([
      { number: 8, title: 'Newer, elsewhere', author: { login: 'someone' }, headRefName: 'other', isDraft: false, updatedAt: '2026-10-20T00:00:00Z' },
      { number: PR, title: TITLE, author: { login: 'octo' }, headRefName: 'fix-expiry', isDraft: false, updatedAt: '2026-10-01T00:00:00Z' },
    ]),
  );
  gh.reply(
    'viewerViewedState',
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            files: {
              pageInfo: { hasNextPage: false },
              nodes: (options.viewed ?? []).map((p) => ({ path: p, viewerViewedState: 'VIEWED' })),
            },
          },
        },
      },
    }),
  );
  gh.reply('FileAsViewed', '{}');
  gh.reply(
    `pulls/${PR}/comments --jq`,
    (options.comments ?? [])
      .map((c) => JSON.stringify({ ...c, commit_id: head, original_line: c.line, original_commit_id: head, side: 'RIGHT' }) + '\n')
      .join(''),
  );
  return head;
}

/** Pick the top pull request in the list, and wait for it and what GitHub says about it. */
async function openPullRequest() {
  const api = await jury();
  void vscode.commands.executeCommand('jury.reviewPr');
  await pick(0);
  return waitFor(
    () => (api.host.active?.spec.kind === 'pr' && !api.host.active.loading && api.host.active.viewed ? api.host.active : null),
    'the pull request review',
  );
}

/** Open `file`'s hunk and return one side's editor; in a pull request review both are git's copies. */
async function side(file: string, which: 'old' | 'new' = 'new'): Promise<vscode.TextEditor> {
  const api = await jury();
  const entry = api.nav.entries.find((e) => e.file.path === file)!;
  await api.nav.goToHunk(entry.hunk.id);
  const rev = which === 'new' ? api.host.active?.head : api.host.active?.base;
  return waitFor(
    () =>
      vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.scheme === 'jury' && e.document.uri.path === `/${file}` && new URLSearchParams(e.document.uri.query).get('rev') === rev,
      ),
    `the ${which} side of ${file}`,
  );
}

/** Leave a note on the new side of `file`. */
async function note(file: string, line: number, text: string) {
  const thread = {
    uri: (await side(file)).document.uri,
    range: new vscode.Range(line - 1, 0, line - 1, 0),
    comments: [] as readonly vscode.Comment[],
    collapsibleState: vscode.CommentThreadCollapsibleState.Collapsed,
    dispose: () => {},
  };
  await vscode.commands.executeCommand('jury.createComment', { thread, text });
  return thread;
}

const posted = () => gh.calls().filter((call) => call.line.startsWith(`api --method POST repos/acme/widgets/pulls/${PR}/reviews`));
const replied = () => gh.calls().filter((call) => call.line.includes(`pulls/${PR}/comments/1/replies`));

const THREAD: Remote[] = [
  { id: 1, path: 'src/token.ts', line: 2, user: { login: 'octo' }, body: 'Should this be inclusive?' },
  { id: 2, in_reply_to_id: 1, path: 'src/token.ts', line: 2, user: { login: 'hubot' }, body: 'Agreed.' },
];

/** Other reviewers' threads on screen, each with the GitHub comment a reply to it answers. */
async function remoteThreads(): Promise<Map<vscode.CommentThread, number>> {
  const { comments } = await jury();
  return (comments as unknown as { remote: Map<vscode.CommentThread, number> }).remote;
}

/** Open the pull request with `THREAD` on it, and return that thread once it is on screen. */
async function openWithThread(): Promise<{ session: Session; thread: vscode.CommentThread; head: string }> {
  const head = await pullRequest({ comments: THREAD });
  const session = await openPullRequest();
  const [thread, root] = await waitFor(async () => [...(await remoteThreads())][0], "the other reviewers' thread");
  assert.equal(root, 1);
  return { session, thread, head };
}

suite('pull request review', () => {
  let undo: (() => Promise<void>) | undefined;

  setup(async () => {
    undo = await configure({ 'ai.enabled': false });
  });

  teardown(async () => {
    await undo?.();
  });

  test('the pull request for this branch is offered first, and opens against its merge base', async () => {
    const head = await pullRequest();

    const session = await openPullRequest();

    assert.equal(session.title, `#${PR} — ${TITLE}`);
    assert.equal(session.head, head);
    assert.deepEqual(
      session.files.map((f) => f.path),
      ['src/clock.ts', 'src/token.ts'],
      'what main did since is not part of it',
    );
  });

  test('nothing is checked out: the branch and the working tree are left alone', async () => {
    await pullRequest();
    const before = repo.git('rev-parse', 'HEAD');

    await openPullRequest();

    assert.equal(repo.git('rev-parse', 'HEAD'), before);
    assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'fix-expiry');
    assert.equal(repo.git('status', '--porcelain'), '');
    assert.equal(repo.git('rev-parse', `refs/jury/pr-${PR}`), before, 'the head is kept in a ref of its own');
  });

  test('files already marked viewed on GitHub open ticked', async () => {
    await pullRequest({ viewed: ['src/clock.ts'] });

    const session = await openPullRequest();

    await waitFor(() => session.marks.size > 0, 'the viewed file to be ticked');
    const ticked = session.files.filter((f) => f.hunks.every((h) => session.marks.has(h.id))).map((f) => f.path);
    assert.deepEqual(ticked, ['src/clock.ts']);
  });

  test('ticking a whole file marks it viewed on GitHub, and unticking unmarks it', async () => {
    await pullRequest();
    const session = await openPullRequest();
    const viewedCall = (verb: string) =>
      gh.calls().find((c) => c.line.includes(`f0: ${verb}(`) && c.line.includes('p0=src/token.ts'));

    const token = (await jury()).nav.entries.find((e) => e.file.path === 'src/token.ts')!;
    await (await jury()).nav.goToHunk(token.hunk.id);
    await vscode.commands.executeCommand('jury.toggleReviewed');
    await waitFor(() => viewedCall('markFileAsViewed'), 'markFileAsViewed for src/token.ts');

    await vscode.commands.executeCommand('jury.toggleReviewed');
    await waitFor(() => viewedCall('unmarkFileAsViewed'), 'unmarkFileAsViewed for src/token.ts');
    await waitFor(() => session.viewed?.size === 0, 'GitHub to be believed back where it started');
  });

  test("other reviewers' comments on the pull request are read in", async () => {
    await pullRequest({
      comments: [
        { id: 1, path: 'src/token.ts', line: 2, user: { login: 'octo' }, body: 'Should this be inclusive?' },
        { id: 2, in_reply_to_id: 1, path: 'src/token.ts', line: 2, user: { login: 'hubot' }, body: 'Agreed.' },
      ],
    });

    const session = await openPullRequest();

    await waitFor(() => session.remoteComments.length === 2, 'the two comments');
    assert.deepEqual(
      session.remoteComments.map((c) => [c.author, c.body, c.replyTo]),
      [
        ['octo', 'Should this be inclusive?', null],
        ['hubot', 'Agreed.', 1],
      ],
    );
    assert.equal(session.comments.length, 0, 'they are not the reviewer’s own notes');
  });

  test('a refresh moves the review on to what the author pushed since, keeping ticks', async () => {
    await pullRequest();
    const session = await openPullRequest();
    const clock = (await jury()).nav.entries.find((e) => e.file.path === 'src/clock.ts')!;
    await (await jury()).nav.goToHunk(clock.hunk.id);
    await vscode.commands.executeCommand('jury.toggleReviewed');

    repo.write({ 'src/extra.ts': 'export const extra = 1;\n' });
    repo.commit('one more thing');
    const pushed = repo.git('rev-parse', 'HEAD').trim();
    repo.git('push', '-q', 'origin', `HEAD:refs/pull/${PR}/head`);
    await vscode.commands.executeCommand('jury.refresh');

    assert.equal(session.head, pushed);
    assert.ok(session.files.some((f) => f.path === 'src/extra.ts'));
    assert.ok(session.marks.has(clock.hunk.id), 'the untouched tick is kept');
    assert.ok(session.changed.size > 0);
  });

  test('submitting shows what will be sent, sends the open notes once, and not again', async () => {
    const head = await pullRequest();
    gh.reply(
      `--method POST repos/acme/widgets/pulls/${PR}/reviews`,
      JSON.stringify({ id: 555, html_url: `https://github.com/acme/widgets/pull/${PR}#pullrequestreview-555` }),
    );
    const session = await openPullRequest();
    await note('src/token.ts', 2, 'Is <= intended?');
    const settled = await note('src/clock.ts', 2, 'Seconds, not milliseconds?');
    await vscode.commands.executeCommand('jury.resolveComment', settled);

    dialogs.choose(/^Comment$/);
    dialogs.type('Looks good overall');
    dialogs.answer(/^Send this review to acme\/widgets#7\?$/, 'Send');
    await vscode.commands.executeCommand('jury.submitReview');

    await waitFor(() => documentText(`Review of #${PR}.md`).startsWith('Comment on acme/widgets#7'), 'the preview');
    const preview = documentText(`Review of #${PR}.md`);
    assert.match(preview, /Is <= intended\?/);
    assert.match(preview, /1 not sent:\n {2}Seconds, not milliseconds\? — marked resolved/);
    assert.equal(posted().length, 1);
    assert.deepEqual(JSON.parse(posted()[0]!.stdin), {
      commit_id: head,
      body: 'Looks good overall',
      event: 'COMMENT',
      comments: [{ path: 'src/token.ts', line: 2, side: 'RIGHT', body: 'Is <= intended?' }],
    });
    assert.equal(dialogs.said.find((s) => s.message.startsWith('Send this review'))?.detail, '1 inline comments will be posted to GitHub.');
    assert.ok(dialogs.messages('info').includes('Jury: review posted.'));
    assert.equal(session.comments.find((c) => c.body === 'Is <= intended?')?.posted?.reviewId, 555);

    dialogs.choose(/^Comment$/);
    dialogs.type('');
    await vscode.commands.executeCommand('jury.submitReview');
    assert.ok(dialogs.messages('info').includes('Jury: nothing to send — no new notes and no summary.'));
    assert.equal(posted().length, 1, 'the note is not sent twice');
  });

  test('a draft goes into a pending review that only the reviewer can see', async () => {
    await pullRequest();
    gh.reply(`repos/acme/widgets/pulls/${PR}/reviews --jq`, '');
    gh.reply(`--method POST repos/acme/widgets/pulls/${PR}/reviews`, JSON.stringify({ id: 556, html_url: 'https://example.invalid' }));
    await openPullRequest();
    await note('src/token.ts', 2, 'Is <= intended?');

    dialogs.choose(/^Draft$/);
    dialogs.type('');
    dialogs.answer(/^Send this as a draft review to acme\/widgets#7\?$/, 'Send');
    await vscode.commands.executeCommand('jury.submitReview');

    assert.equal(posted().length, 1);
    assert.equal('event' in JSON.parse(posted()[0]!.stdin), false, 'no event leaves the review pending');
    assert.ok(dialogs.messages('info').includes('Jury: draft review saved on GitHub. Submit it there when you are done.'));
  });

  test('declining the confirmation sends nothing', async () => {
    await pullRequest();
    await openPullRequest();
    await note('src/token.ts', 2, 'Is <= intended?');

    dialogs.choose(/^Approve$/);
    dialogs.type('LGTM');
    await vscode.commands.executeCommand('jury.submitReview');

    await waitFor(() => documentText(`Review of #${PR}.md`).startsWith('Approve acme/widgets#7'), 'the preview');
    assert.equal(posted().length, 0);
  });

  test("a reply to another reviewer's thread is confirmed, sent to its first comment, and shown in it", async () => {
    const { session, thread, head } = await openWithThread();
    assert.equal(thread.contextValue, 'remote', 'the reply box offers Reply on GitHub, not Add Note');
    gh.reply(
      `--method POST repos/acme/widgets/pulls/${PR}/comments/1/replies`,
      JSON.stringify({
        id: 3,
        in_reply_to_id: 1,
        path: 'src/token.ts',
        line: 2,
        commit_id: head,
        original_line: 2,
        original_commit_id: head,
        side: 'RIGHT',
        user: { login: 'me' },
        body: 'Yes: a token expires at its time.',
      }),
    );

    dialogs.answer(/^Reply on acme\/widgets#7\?$/, 'Reply');
    await vscode.commands.executeCommand('jury.replyOnGitHub', { thread, text: 'Yes: a token expires at its time.' });

    assert.match(dialogs.said.find((s) => s.message === 'Reply on acme/widgets#7?')?.detail ?? '', /Yes: a token expires at its time\./);
    assert.equal(replied().length, 1);
    assert.deepEqual(JSON.parse(replied()[0]!.stdin), { body: 'Yes: a token expires at its time.' });

    const [shown] = [...(await remoteThreads())].find(([, root]) => root === 1)!;
    assert.deepEqual(
      shown.comments.map((c) => [c.author.name, typeof c.body === 'string' ? c.body : c.body.value]),
      [
        ['octo', 'Should this be inclusive?'],
        ['hubot', 'Agreed.'],
        ['me', 'Yes: a token expires at its time.'],
      ],
    );
    assert.equal(shown.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded, 'the thread replied to stays open');
    assert.equal(session.comments.length, 0, 'a reply is not a note to export or post again');
  });

  test('declining to send a reply sends nothing', async () => {
    const { thread } = await openWithThread();

    await vscode.commands.executeCommand('jury.replyOnGitHub', { thread, text: 'Never mind.' });

    assert.ok(dialogs.said.some((s) => s.message === 'Reply on acme/widgets#7?'));
    assert.equal(replied().length, 0);
  });

  test('a reply GitHub refuses is reported, not shown, and can be copied', async () => {
    const { session, thread } = await openWithThread();
    gh.reply(`comments/1/replies`, 'HTTP 422: Validation Failed', 1);

    dialogs.answer(/^Reply on/, 'Reply');
    dialogs.answer(/^Jury: the reply was not posted/, 'Copy Reply');
    await vscode.commands.executeCommand('jury.replyOnGitHub', { thread, text: 'Yes: a token expires at its time.' });

    assert.deepEqual(dialogs.messages('error'), ['Jury: the reply was not posted — HTTP 422: Validation Failed']);
    assert.equal(session.remoteComments.length, 2);
    assert.equal(await vscode.env.clipboard.readText(), 'Yes: a token expires at its time.');
  });

  test('a suggested change starts from the diff’s line and is submitted as a GitHub suggestion', async () => {
    const head = await pullRequest();
    gh.reply(`--method POST repos/acme/widgets/pulls/${PR}/reviews`, JSON.stringify({ id: 557, html_url: 'https://example.invalid' }));
    const session = await openPullRequest();
    const editor = await side('src/token.ts');
    await vscode.window.showTextDocument(editor.document, { selection: new vscode.Range(1, 4, 1, 4) });

    await vscode.commands.executeCommand('jury.suggestChange');

    const [suggested] = session.comments;
    assert.equal(suggested?.body, '```suggestion\n  return at <= now;\n```');
    suggested!.body = suggested!.body.replace('<=', '<');

    dialogs.choose(/^Comment$/);
    dialogs.type('');
    dialogs.answer(/^Send this review/, 'Send');
    await vscode.commands.executeCommand('jury.submitReview');

    assert.deepEqual(JSON.parse(posted()[0]!.stdin).comments, [
      { path: 'src/token.ts', line: 2, side: 'RIGHT', body: '```suggestion\n  return at < now;\n```' },
    ]);
    assert.equal(JSON.parse(posted()[0]!.stdin).commit_id, head);
  });

  test('a suggested change on the old side is refused, and starts no note', async () => {
    await pullRequest();
    const session = await openPullRequest();
    const editor = await side('src/token.ts', 'old');
    await vscode.window.showTextDocument(editor.document, { selection: new vscode.Range(1, 0, 1, 0) });

    await vscode.commands.executeCommand('jury.suggestChange');

    assert.deepEqual(dialogs.messages('warning'), ['Jury: put the cursor on a changed line in the new version of a file.']);
    assert.equal(session.comments.length, 0);
  });

  test('submitting with no pull request open says so', async () => {
    fake.reset();
    await repo.reset(BASE);
    repo.write(CHANGE);
    await review();

    await vscode.commands.executeCommand('jury.submitReview');

    assert.deepEqual(dialogs.messages('info'), ['Jury: open a pull request review first.']);
  });

  test('a pull request gh cannot describe is reported, and nothing opens', async () => {
    fake.reset();
    await repo.reset(BASE);
    gh.reply('^pr list', JSON.stringify([{ number: 9, title: 'Gone', author: { login: 'x' }, headRefName: 'gone', isDraft: false, updatedAt: '' }]));
    const api = await jury();

    void vscode.commands.executeCommand('jury.reviewPr');
    await pick(0);

    await waitFor(() => dialogs.messages('error').length > 0, 'an error');
    assert.match(dialogs.messages('error')[0]!, /^Jury: fake gh: no reply scripted for: pr view 9 /);
    assert.equal(api.host.active, null);
  });
});
