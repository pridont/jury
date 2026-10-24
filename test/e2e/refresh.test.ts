import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { addNote, configure, dialogs, documentText, fake, repo, review, row, sidebar, waitFor } from './harness.js';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// `a.ts` has two hunks, near its top and its bottom; `b.ts` one, in the middle.
const BASE = { 'src/a.ts': lines(40), 'src/b.ts': lines(40) };
const EDITED = {
  'src/a.ts': lines(40).replace('line 1\n', 'line 1 edited\n').replace('line 39\n', 'line 39 edited\n'),
  'src/b.ts': lines(40).replace('line 20\n', 'line 20 edited\n'),
};
const NOTE = 'Is this the right bound?';

const refresh = () => vscode.commands.executeCommand('jury.refresh');

suite('refresh', () => {
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

  test('ticks on untouched hunks survive and an edited hunk is unticked', async () => {
    const api = await review();
    await vscode.commands.executeCommand('jury.nextHunk');
    await vscode.commands.executeCommand('jury.markLayerReviewed');
    await vscode.commands.executeCommand('jury.markLayerReviewed');
    assert.deepEqual(api.nav.progress, { reviewed: 3, total: 3 });

    repo.write({ 'src/b.ts': lines(40).replace('line 20\n', 'line 20 edited again\n') });
    await refresh();

    assert.deepEqual(api.nav.progress, { reviewed: 2, total: 3 });
    assert.match(await sidebar(), /\[ \] 2\. b\.ts — changed · 0\/1/);
  });

  test('comes back to the hunk being read', async () => {
    const api = await review();
    const second = api.nav.entries[1]!;
    await api.nav.goToHunk(second.hunk.id);

    repo.write({ 'src/b.ts': lines(40).replace('line 20\n', 'line 20 edited again\n') });
    await refresh();

    await waitFor(() => api.nav.current?.hunk.id === second.hunk.id, 'the same a.ts hunk');
  });

  test('once every change is reverted there is nothing to review', async () => {
    await review();

    repo.git('checkout', '--', '.');
    await refresh();

    assert.equal(await sidebar(), 'No changes to review.');
  });

  test('asks the model to group the change again', async () => {
    await undo?.();
    undo = undefined;
    const api = await review('jury.review', { clustered: true });
    const grouped = () => fake.calls().filter((c) => c.system.includes('organise code reviews')).length;
    assert.equal(grouped(), 1);

    repo.write({ 'src/b.ts': lines(40).replace('line 20\n', 'line 20 edited again\n') });
    await refresh();

    await waitFor(() => grouped() === 2 && api.host.active?.clustered, 'the second grouping');
  });

  test('a note on edited code follows it, flagged as approximate', async () => {
    const api = await review();
    await addNote('src/b.ts', 20, NOTE);

    repo.write({ 'src/b.ts': lines(40).replace('line 20\n', 'line 20 edited again\n') });
    await refresh();

    const note = api.host.active!.comments[0]!;
    assert.equal(note.orphaned ?? false, false);
    assert.equal(note.moved, true);
    void vscode.commands.executeCommand('jury.export');
    await waitFor(() => documentText('Review.md').includes(`**src/b.ts:20** _(position is approximate)_`), 'the flag in the export');
  });

  test('a note whose code is gone is kept aside, and the export lists it', async () => {
    const api = await review();
    await addNote('src/b.ts', 20, NOTE);

    repo.git('checkout', '--', 'src/b.ts');
    await refresh();

    assert.equal(api.host.active!.comments[0]?.orphaned, true);
    assert.match(await sidebar(), new RegExp(`Notes whose code is gone — 1\\n  ${NOTE.replace('?', '\\?')}`));
    void vscode.commands.executeCommand('jury.export');
    await waitFor(
      () => documentText('Review.md').includes(`## Comments whose code is gone\n\n- ${NOTE}`),
      'the orphan in the export',
    );
  });

  test('re-pinning puts a note whose code is gone back on a hunk', async () => {
    const api = await review();
    await addNote('src/b.ts', 20, NOTE);
    repo.git('checkout', '--', 'src/b.ts');
    await refresh();

    dialogs.choose(/a\.ts/);
    await vscode.commands.executeCommand('jury.repinComment', (await row(new RegExp(NOTE.replace('?', '\\?')))).node);

    const note = api.host.active!.comments[0]!;
    assert.equal(note.orphaned, false);
    assert.equal(note.moved, true);
    assert.ok(api.host.active!.files[0]!.hunks.some((h) => h.id === note.hunkId), 'on an a.ts hunk');
    assert.doesNotMatch(await sidebar(), /Notes whose code is gone/);
  });

  test('discarding a note whose code is gone deletes it', async () => {
    const api = await review();
    await addNote('src/b.ts', 20, NOTE);
    repo.git('checkout', '--', 'src/b.ts');
    await refresh();

    await vscode.commands.executeCommand('jury.discardComment', (await row(new RegExp(NOTE.replace('?', '\\?')))).node);

    assert.equal(api.host.active!.comments.length, 0);
    assert.doesNotMatch(await sidebar(), /Notes whose code is gone/);
  });
});
