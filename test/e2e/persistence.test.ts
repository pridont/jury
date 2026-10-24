import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { configure, dialogs, fake, jury, repo, review } from './harness.js';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

const BASE = { 'src/a.ts': lines(5), 'src/b.ts': lines(5) };
const EDITED = {
  'src/a.ts': lines(5).replace('line 3', 'line 3 edited'),
  'src/b.ts': lines(5).replace('line 3', 'line 3 edited'),
};

/** Where review state lives: inside `.git`, so it is never committed. */
const stateDir = () => path.join(repo.root, '.git', 'jury');
const saved = () => (fs.existsSync(stateDir()) ? fs.readdirSync(stateDir()) : []);

/** Tick the first hunk of the open review. */
async function tickFirst(): Promise<string> {
  const api = await jury();
  await api.nav.goToHunk(api.nav.entries[0]!.hunk.id);
  await vscode.commands.executeCommand('jury.toggleReviewed');
  return api.nav.entries[0]!.hunk.id;
}

suite('saved reviews', () => {
  let undo: (() => Promise<void>) | undefined;

  setup(async () => {
    fake.reset();
    undo = await configure({ 'ai.enabled': false });
    await repo.reset(BASE);
    repo.write(EDITED);
  });

  teardown(async () => {
    await undo?.();
  });

  test('a tick is saved inside .git and is back when the review is reopened', async () => {
    const api = await review();
    const id = await tickFirst();

    const file = saved().find((name) => name.endsWith('.json'));
    assert.ok(file, `state written: ${saved().join(', ')}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir(), file), 'utf8')).marks, [id]);

    await vscode.commands.executeCommand('jury.close');
    await review();
    assert.ok(api.host.active!.marks.has(id));
    assert.deepEqual(api.nav.progress, { reviewed: 1, total: 2 });
  });

  test('the working tree and the staged changes are separate reviews', async () => {
    const api = await review();
    await tickFirst();
    repo.git('add', 'src/a.ts');

    await review('jury.reviewStaged');
    assert.equal(api.host.active!.marks.size, 0, 'staged starts from nothing');
    await tickFirst();

    dialogs.choose(/^working tree$/);
    await vscode.commands.executeCommand('jury.list');
    assert.equal(api.host.active?.spec.kind, 'worktree');
    assert.equal(api.host.active!.marks.size, 1);
    assert.equal(saved().length, 2);
  });

  test('resume reopens the review touched last', async () => {
    const api = await review();
    await tickFirst();
    repo.git('add', 'src/a.ts');
    await review('jury.reviewStaged');
    await tickFirst();
    await vscode.commands.executeCommand('jury.close');

    await vscode.commands.executeCommand('jury.resume');

    assert.equal(api.host.active?.spec.kind, 'staged');
  });

  test('with nothing saved, resume and the saved list say so and open nothing', async () => {
    const api = await jury();

    await vscode.commands.executeCommand('jury.resume');
    await vscode.commands.executeCommand('jury.list');

    assert.equal(api.host.active, null);
    assert.deepEqual(dialogs.messages('info'), [
      'Jury: no saved review for this repository.',
      'Jury: no saved reviews for this repository.',
    ]);
  });

  test('an unreadable saved review is set aside, not overwritten, and the review starts fresh', async () => {
    const api = await review();
    await tickFirst();
    await vscode.commands.executeCommand('jury.close');
    const [file] = saved();
    fs.writeFileSync(path.join(stateDir(), file!), '{ not json');

    await review();

    assert.equal(api.host.active!.marks.size, 0);
    const aside = saved().find((name) => name.startsWith(`${file}.unreadable-`));
    assert.ok(aside, saved().join(', '));
    assert.equal(fs.readFileSync(path.join(stateDir(), aside), 'utf8'), '{ not json');
  });
});
