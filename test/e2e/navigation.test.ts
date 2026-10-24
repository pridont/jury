import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { Api } from '../../src/extension.js';
import { fake, repo, review, row, sidebar, waitFor } from './harness.js';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// Without a model the review groups by file: `a.ts` (2 hunks), `b.ts` (1), then scaffolding.
const BASE = {
  'src/a.ts': lines(40),
  'src/b.ts': lines(5),
  'package-lock.json': '{\n  "lockfileVersion": 3\n}\n',
};

suite('review navigation', () => {
  setup(async () => {
    fake.reset();
    await vscode.commands.executeCommand('jury.showReviewed');
    await repo.reset(BASE);
    repo.write({
      'src/a.ts': lines(40).replace('line 1\n', 'line 1 edited\n').replace('line 39\n', 'line 39 edited\n'),
      'src/b.ts': lines(5).replace('line 3', 'line 3 edited'),
      'package-lock.json': '{\n  "lockfileVersion": 3,\n  "x": 1\n}\n',
    });
    await vscode.workspace.getConfiguration('jury').update('ai.enabled', false, vscode.ConfigurationTarget.Workspace);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('jury.showReviewed');
    await vscode.workspace.getConfiguration('jury').update('ai.enabled', undefined, vscode.ConfigurationTarget.Workspace);
  });

  test('hide reviewed hides ticked rows until everything is reviewed', async () => {
    const api = await review();

    await vscode.commands.executeCommand('jury.nextUnreviewed');
    await vscode.commands.executeCommand('jury.markLayerReviewed');
    await vscode.commands.executeCommand('jury.hideReviewed');
    const tree = await sidebar();
    assert.doesNotMatch(tree, /a\.ts/);
    assert.match(tree, /b\.ts — 0\/1/);

    await vscode.commands.executeCommand('jury.markLayerReviewed');
    assert.deepEqual(api.nav.progress, { reviewed: 3, total: 3 });
    assert.match(await sidebar(), /Everything is reviewed\./);

    await vscode.commands.executeCommand('jury.showReviewed');
    assert.match(await sidebar(), /a\.ts — 2\/2/);
  });

  test('refresh marks edited rows changed and next/previous changed step to them', async () => {
    const api = await review();
    const first = api.nav.current!;
    await vscode.commands.executeCommand('jury.nextChanged');
    assert.equal(api.nav.current?.hunk.id, first.hunk.id, 'nothing changed before any refresh');

    repo.write({ 'src/b.ts': lines(5).replace('line 3', 'line 3 edited again') });
    await vscode.commands.executeCommand('jury.refresh');
    await waitFor(() => !api.host.active?.loading, 'the refresh');
    const session = api.host.active!;
    assert.equal(session.changed.size, 1);
    const tree = await sidebar();
    assert.match(tree, /b\.ts — changed/);
    assert.doesNotMatch(tree, /a\.ts — changed/);

    assert.equal(api.nav.current?.file.path, 'src/a.ts');
    await vscode.commands.executeCommand('jury.nextChanged');
    const changed = [...session.changed][0];
    assert.equal(api.nav.current?.hunk.id, changed);
    await vscode.commands.executeCommand('jury.prevChanged');
    assert.equal(api.nav.current?.hunk.id, changed, 'nothing changed before it');
  });

  test('stepping onto a hidden row still moves, with no row to select', async () => {
    const api = await review();
    await vscode.commands.executeCommand('jury.nextUnreviewed');
    const first = api.nav.current!;
    await vscode.commands.executeCommand('jury.markLayerReviewed');
    await vscode.commands.executeCommand('jury.hideReviewed');

    await vscode.commands.executeCommand('jury.prevHunk');
    assert.equal(api.nav.current?.layer.id, first.layer.id, 'lands back in the hidden a.ts layer');
    assert.equal(api.tree.nodeForPosition(first.cohortIndex, first.layerIndex, first.file.path), undefined);
  });

  test('next and previous hunk walk the reading order and stop at its ends', async () => {
    const api = await review();
    const at = () => where(api);

    const walked: string[] = [];
    for (const command of ['next', 'next', 'next', 'next', 'prev', 'prev', 'prev']) {
      await vscode.commands.executeCommand(command === 'next' ? 'jury.nextHunk' : 'jury.prevHunk');
      walked.push(at());
    }

    assert.deepEqual(walked, ['a.ts:1', 'a.ts:36', 'b.ts:1', 'b.ts:1', 'a.ts:36', 'a.ts:1', 'a.ts:1']);
  });

  test('next and previous layer land on the first hunk not yet reviewed', async () => {
    const api = await review();
    await vscode.commands.executeCommand('jury.nextHunk');
    await vscode.commands.executeCommand('jury.toggleReviewed');

    await vscode.commands.executeCommand('jury.nextLayer');
    assert.equal(where(api), 'b.ts:1');
    await vscode.commands.executeCommand('jury.prevLayer');
    assert.equal(where(api), 'a.ts:36', 'the a.ts hunk still to read');
  });

  test('mark layer reviewed ticks the whole step and moves on to the next', async () => {
    const api = await review();
    await vscode.commands.executeCommand('jury.nextHunk');

    await vscode.commands.executeCommand('jury.markLayerReviewed');

    assert.deepEqual(api.nav.progress, { reviewed: 2, total: 3 });
    assert.equal(where(api), 'b.ts:1');
    assert.match(await sidebar(), /\[x\] 1\. a\.ts — 2\/2/);
  });

  test('opening a step from its row goes to its first hunk not yet reviewed', async () => {
    const api = await review();
    await vscode.commands.executeCommand('jury.nextHunk');
    await vscode.commands.executeCommand('jury.toggleReviewed');
    await vscode.commands.executeCommand('jury.nextLayer');

    const { item } = await row(/a\.ts/);
    await vscode.commands.executeCommand(item.command!.command, ...(item.command!.arguments ?? []));

    assert.equal(where(api), 'a.ts:36');
  });

  test('moving the cursor in the diff moves the review with it', async () => {
    const api = await review();
    await vscode.commands.executeCommand('jury.nextHunk');
    const editor = await waitFor(
      () => vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath.endsWith('a.ts') && e.document.uri.scheme === 'file'),
      'the a.ts editor',
    );

    editor.selection = new vscode.Selection(38, 0, 38, 0);

    await waitFor(() => where(api) === 'a.ts:36', `the review to follow the cursor, not stay on ${where(api)}`);
  });

  test('next unreviewed skips hunks already ticked', async () => {
    const api = await review();
    const second = api.nav.entries[1]!;
    await api.nav.goToHunk(second.hunk.id);
    await vscode.commands.executeCommand('jury.toggleReviewed');
    await api.nav.goToHunk(api.nav.entries[0]!.hunk.id);

    await vscode.commands.executeCommand('jury.nextUnreviewed');
    assert.equal(where(api), 'b.ts:1');
    await vscode.commands.executeCommand('jury.prevUnreviewed');
    assert.equal(where(api), 'a.ts:1');
  });

  test('mark cohort reviewed ticks every hunk in the cohort', async () => {
    const api = await review();

    await vscode.commands.executeCommand('jury.markCohortReviewed', (await row(/a\.ts/)).node);

    assert.deepEqual(api.nav.progress, { reviewed: 2, total: 3 });
    assert.equal(api.nav.current, api.nav.entries[0], 'marking from the tree does not move the reading');
  });

  test('toggling reviewed twice unticks the hunk', async () => {
    const api = await review();
    await vscode.commands.executeCommand('jury.nextHunk');

    await vscode.commands.executeCommand('jury.toggleReviewed');
    await vscode.commands.executeCommand('jury.toggleReviewed');

    assert.deepEqual(api.nav.progress, { reviewed: 0, total: 3 });
  });
});

/** Where the review is: file name and the first new line of the current hunk. */
function where(api: Api): string {
  const entry = api.nav.current;
  return entry ? `${entry.file.path.split('/').pop()}:${entry.hunk.newStart}` : 'nowhere';
}
