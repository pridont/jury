import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { fake, repo, review, sidebar, waitFor } from './harness.js';

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
});
