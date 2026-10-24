import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { configure, dialogs, documentText, fake, repo, review, sidebar, waitFor } from './harness.js';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// The fake groups files in reverse, two per cohort: `src/c.ts` and `src/b.ts` are the two
// steps of cohort 1, and `src/a.ts` (two hunks) is cohort 2 on its own.
const BASE = { 'src/a.ts': lines(40), 'src/b.ts': lines(5), 'src/c.ts': lines(5) };
const EDITED = {
  'src/a.ts': lines(40).replace('line 1\n', 'line 1 edited\n').replace('line 39\n', 'line 39 edited\n'),
  'src/b.ts': lines(5).replace('line 3', 'line 3 edited'),
  'src/c.ts': lines(5).replace('line 3', 'line 3 edited'),
};

type Thread = {
  uri: vscode.Uri;
  range: vscode.Range;
  comments: readonly vscode.Comment[];
  collapsibleState: vscode.CommentThreadCollapsibleState;
  dispose: () => void;
};

/** Leave a note the way the comment gutter does, and keep the thread Jury fills in. */
async function note(uri: vscode.Uri, line: number, text: string): Promise<Thread> {
  const thread: Thread = {
    uri,
    range: new vscode.Range(line - 1, 0, line - 1, 0),
    comments: [],
    collapsibleState: vscode.CommentThreadCollapsibleState.Collapsed,
    dispose: () => {},
  };
  await vscode.commands.executeCommand('jury.createComment', { thread, text });
  return thread;
}

const file = (relative: string) => vscode.Uri.file(path.join(repo.root, relative));
const bodyOf = (comment: vscode.Comment | undefined) =>
  typeof comment?.body === 'string' ? comment.body : (comment?.body.value ?? '');

suite('notes', () => {
  let undo: (() => Promise<void>) | undefined;

  setup(async () => {
    fake.reset();
    undo = await configure({ 'ai.enabled': false });
    await repo.reset(BASE);
    repo.write(EDITED);
  });

  teardown(async () => {
    await undo?.();
    undo = undefined;
  });

  test('a note on an unchanged line is refused', async () => {
    const api = await review();

    await note(file('src/a.ts'), 20, 'Nothing changed here');

    assert.equal(api.host.active!.comments.length, 0);
    assert.deepEqual(dialogs.messages('warning'), ['Jury: a note has to sit on a changed line.']);
  });

  test('editing a note and saving it changes what it says, and that is kept', async () => {
    const api = await review();
    const thread = await note(file('src/b.ts'), 3, 'First thought');

    await vscode.commands.executeCommand('jury.editComment', thread.comments[0]);
    assert.equal(thread.comments[0]?.mode, vscode.CommentMode.Editing);
    await vscode.commands.executeCommand('jury.saveComment', { ...thread.comments[0], body: 'Second thought' });

    assert.equal(bodyOf(thread.comments[0]), 'Second thought');
    assert.equal(thread.comments[0]?.mode, vscode.CommentMode.Preview);
    await vscode.commands.executeCommand('jury.close');
    await review();
    assert.equal(api.host.active!.comments[0]?.body, 'Second thought');
  });

  test('cancelling an edit keeps the note as it was', async () => {
    const api = await review();
    const thread = await note(file('src/b.ts'), 3, 'First thought');

    await vscode.commands.executeCommand('jury.editComment', thread.comments[0]);
    await vscode.commands.executeCommand('jury.cancelComment', { ...thread.comments[0], body: 'Half-typed' });

    assert.equal(bodyOf(thread.comments[0]), 'First thought');
    assert.equal(api.host.active!.comments[0]?.body, 'First thought');
  });

  test('saving a note emptied of text deletes it', async () => {
    const api = await review();
    const thread = await note(file('src/b.ts'), 3, 'First thought');

    await vscode.commands.executeCommand('jury.saveComment', { ...thread.comments[0], body: '   ' });

    assert.equal(api.host.active!.comments.length, 0);
  });

  test('deleting a note removes it for good', async () => {
    const api = await review();
    const thread = await note(file('src/b.ts'), 3, 'First thought');

    await vscode.commands.executeCommand('jury.deleteComment', thread.comments[0]);

    assert.equal(api.host.active!.comments.length, 0);
    await vscode.commands.executeCommand('jury.close');
    await review();
    assert.equal(api.host.active!.comments.length, 0);
  });

  test('a note on a removed line sits on the old side', async () => {
    await repo.reset(BASE);
    repo.write({ 'src/b.ts': lines(5).replace('line 3\n', '') });
    const api = await review();
    const entry = api.nav.entries[0]!;
    await api.nav.goToHunk(entry.hunk.id);
    const before = await waitFor(
      () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'jury')?.document.uri,
      'the old side of the diff',
    );

    await note(before, 3, 'Why remove this?');

    assert.equal(api.host.active!.comments[0]?.side, 'old');
    void vscode.commands.executeCommand('jury.export');
    await waitFor(() => documentText('Review.md').includes('**src/b.ts:3**'), 'the note at its old line');
  });

  test('a step row counts the notes on it', async () => {
    await undo?.();
    undo = undefined;
    await review('jury.review', { clustered: true });

    await note(file('src/b.ts'), 3, 'One');
    await note(file('src/b.ts'), 4, 'Two');

    assert.match(await sidebar(), /Fake layer src\/b\.ts — 2 notes · /);
  });

  test('a one-step cohort row counts the notes on it, as the step row would', async () => {
    await undo?.();
    undo = undefined;
    await review('jury.review', { clustered: true });

    await note(file('src/a.ts'), 1, 'One');

    assert.match(await sidebar(), /2\. Fake cohort 2 — 1 note · /);
  });

  test('the export reads in cohort order, with a file:line for every note', async () => {
    await undo?.();
    undo = undefined;
    await review('jury.review', { clustered: true });
    await note(file('src/a.ts'), 39, 'Off by one?');
    await note(file('src/c.ts'), 3, 'Why here?');
    await vscode.commands.executeCommand('jury.nextHunk');
    await vscode.commands.executeCommand('jury.toggleReviewed');

    void vscode.commands.executeCommand('jury.export');

    await waitFor(() => documentText('Review.md').includes('Off by one?'), 'the export');
    const markdown = documentText('Review.md');
    assert.match(markdown, /^# Review — working tree\n\n3 files · 4 hunks · 1 reviewed · 2 comments\n\n`[0-9a-f]{12}` → `worktree`\n/);
    assert.ok(
      markdown.indexOf('## 1. Fake cohort 1') < markdown.indexOf('**src/c.ts:3**') &&
        markdown.indexOf('**src/c.ts:3**') < markdown.indexOf('## 2. Fake cohort 2') &&
        markdown.indexOf('## 2. Fake cohort 2') < markdown.indexOf('**src/a.ts:39**'),
      markdown,
    );
    assert.match(markdown, /### Fake layer src\/c\.ts\n\n- \*\*src\/c\.ts:3\*\*\n {2}Why here\?/);
  });

  test('the export can be copied, or saved to a file', async () => {
    await review();
    await note(file('src/b.ts'), 3, 'Worth a look');

    dialogs.answer(/review exported/, 'Copy');
    await vscode.commands.executeCommand('jury.export');
    await waitFor(() => documentText('Review.md').includes('Worth a look'), 'this export');
    const markdown = documentText('Review.md');
    assert.equal(await vscode.env.clipboard.readText(), markdown);

    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jury-export-')), 'review.md');
    dialogs.answer(/review exported/, 'Save to a file…');
    dialogs.saveTo(vscode.Uri.file(target));
    await vscode.commands.executeCommand('jury.export');
    assert.equal(fs.readFileSync(target, 'utf8'), markdown);
  });
});
