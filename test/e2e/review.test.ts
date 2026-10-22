import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { addNote, documentText, fake, jury, pick, repo, review, sidebar, waitFor } from './harness.js';

const BASE = {
  'src/clock.ts': 'export function now(): number {\n  return Date.now();\n}\n',
  'src/token.ts': 'export function expired(at: number, now: number): boolean {\n  return at < now;\n}\n',
  'test/token.test.ts': "import { expired } from '../src/token';\n",
};

suite('review', () => {
  setup(async () => {
    fake.reset();
    await repo.reset(BASE);
    repo.write({
      'src/clock.ts': 'export function now(): number {\n  return Math.floor(Date.now() / 1000);\n}\n',
      'src/token.ts': 'export function expired(at: number, now: number): boolean {\n  return at <= now;\n}\n',
      'test/token.test.ts': "import { expired } from '../src/token';\nexpired(1, 1);\n",
    });
  });

  test('working tree review shows the model grouping', async () => {
    const api = await review('jury.review', { clustered: true });

    assert.equal(api.host.active?.files.length, 3);
    const tree = await sidebar();
    assert.match(tree, /Fake cohort 1/);
    assert.match(tree, /Fake cohort 2/);
    assert.ok(fake.calls().some((call) => call.system.includes('organise code reviews')));
  });

  test('without a model the review falls back to grouping by file', async () => {
    await vscode.workspace.getConfiguration('jury').update('ai.enabled', false, vscode.ConfigurationTarget.Workspace);
    try {
      const api = await review();
      assert.equal(api.host.active?.clustered, false);
      assert.doesNotMatch(await sidebar(), /Fake cohort/);
      assert.equal(fake.calls().length, 0);
    } finally {
      await vscode.workspace.getConfiguration('jury').update('ai.enabled', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('next hunk opens the change and toggling marks it reviewed', async () => {
    const api = await review('jury.review', { clustered: true });

    await vscode.commands.executeCommand('jury.nextHunk');
    const first = await waitFor(() => api.nav.current, 'a current hunk');
    await waitFor(() => vscode.window.activeTextEditor, 'an editor');

    await vscode.commands.executeCommand('jury.toggleReviewed');
    assert.ok(api.host.active?.marks.has(first.hunk.id));
    assert.equal(api.nav.progress.reviewed, 1);
  });

  test('a note shows up in the markdown export', async () => {
    const api = await review();

    await addNote('src/token.ts', 2, 'Is <= intended here?');
    assert.equal(api.host.active?.comments.length, 1);

    // Export also offers to save; that prompt is left unanswered.
    void vscode.commands.executeCommand('jury.export');
    const markdown = await waitFor(() => documentText('Review.md'), 'the exported review');
    assert.match(markdown, /Is <= intended here\?/);
  });
});

suite('review a commit', () => {
  test('picking a commit from the list opens that commit', async () => {
    await repo.reset({ 'a.ts': 'one\n' });
    repo.write({ 'a.ts': 'two\n' });
    repo.commit('second');
    const api = await jury();

    void vscode.commands.executeCommand('jury.reviewCommit');
    await pick(1);

    const session = await waitFor(() => api.host.active, 'the commit review');
    assert.equal(session.spec.kind === 'commit' && session.spec.subject, 'initial');
  });
});
