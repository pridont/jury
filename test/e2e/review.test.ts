import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { addNote, documentText, fake, jury, pick, repo, review, settle, sidebar, waitFor } from './harness.js';

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
    // The document is reused, so wait for this export rather than read the last one.
    await waitFor(() => /Is <= intended here\?/.test(documentText('Review.md')), 'the note in the exported review');
  });

  test('a resolved note is collapsed, flagged in the export, and reopens', async () => {
    // Clustering re-renders every thread when it lands; wait so the thread below stays the live one.
    const api = await review('jury.review', { clustered: true });
    // The thread the comment gutter would hand over; Jury keeps it as the note's thread.
    const thread = {
      uri: vscode.Uri.file(`${repo.root}/src/token.ts`),
      range: new vscode.Range(1, 0, 1, 0),
      comments: [] as readonly vscode.Comment[],
      collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
      state: undefined as vscode.CommentThreadState | undefined,
      contextValue: undefined as string | undefined,
      dispose: () => {},
    };
    await vscode.commands.executeCommand('jury.createComment', { thread, text: 'Is <= intended here?' });
    assert.equal(thread.contextValue, 'open');

    await vscode.commands.executeCommand('jury.resolveComment', thread);
    assert.equal(api.host.active?.comments[0]?.resolved, true);
    assert.equal(thread.state, vscode.CommentThreadState.Resolved);
    assert.equal(thread.contextValue, 'resolved');
    assert.equal(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);

    void vscode.commands.executeCommand('jury.export');
    await waitFor(() => /src\/token\.ts:2\*\* _\(resolved\)_/.test(documentText('Review.md')), 'the resolved flag in the export');

    await vscode.commands.executeCommand('jury.reopenComment', thread);
    assert.equal(api.host.active?.comments[0]?.resolved, false);
    assert.equal(thread.state, vscode.CommentThreadState.Unresolved);
    assert.equal(thread.contextValue, 'open');

    void vscode.commands.executeCommand('jury.export');
    await waitFor(() => {
      const markdown = documentText('Review.md');
      return /src\/token\.ts:2\*\*\n/.test(markdown) && !markdown.includes('_(resolved)_');
    }, 'the export without the resolved flag');
  });
});

/** The editor tab in front, by its title. */
const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? '';

/** The revision a `jury:` side of the diff is read from. */
const revOf = (uri: vscode.Uri) => new URLSearchParams(uri.query).get('rev');

/** Go to the first hunk of `path` the way stepping would, and wait for its editor. */
async function openFile(path: string): Promise<void> {
  const api = await jury();
  const entry = api.nav.entries.find((e) => e.file.path === path);
  assert.ok(entry, `${path} is in the reading order`);
  await api.nav.goToHunk(entry.hunk.id);
  await waitFor(() => vscode.window.activeTextEditor, 'an editor');
}

/** Wait for a review of `kind` to finish loading, and return it. */
async function loaded(kind: string) {
  const api = await jury();
  return waitFor(
    () => (api.host.active?.spec.kind === kind && !api.host.active.loading ? api.host.active : null),
    `the ${kind} review`,
  );
}

suite('what a review reads', () => {
  setup(() => fake.reset());

  test('a clean working tree says there is nothing to review', async () => {
    await repo.reset(BASE);
    await review();
    assert.equal(await sidebar(), 'No changes to review.');
  });

  test('staged changes leave unstaged edits out and read the new side from the index', async () => {
    await repo.reset(BASE);
    repo.write({ 'src/token.ts': BASE['src/token.ts'].replace('<', '<=') });
    repo.git('add', 'src/token.ts');
    repo.write({ 'src/clock.ts': BASE['src/clock.ts'].replace('Date.now()', 'performance.now()') });

    const api = await review('jury.reviewStaged');

    assert.deepEqual(api.host.active?.files.map((f) => f.path), ['src/token.ts']);
    assert.equal(api.host.active?.title, 'staged changes');
    await openFile('src/token.ts');
    const after = vscode.window.activeTextEditor!.document.uri;
    assert.equal(after.scheme, 'jury');
    assert.equal(revOf(after), 'index');
  });

  test('a new untracked file is in the working tree review, as added', async () => {
    await repo.reset(BASE);
    repo.write({ 'src/fresh.ts': 'export const fresh = true;\n' });

    const api = await review();

    const file = api.host.active?.files.find((f) => f.path === 'src/fresh.ts');
    assert.equal(file?.status, 'added');
    assert.equal(file?.hunks[0]?.lines[0], '+export const fresh = true;');
  });

  test('an untracked binary file is listed as binary rather than shown', async () => {
    await repo.reset(BASE);
    repo.write({ 'logo.bin': 'PNG\0\0\0data' });

    const api = await review();

    const file = api.host.active?.files.find((f) => f.path === 'logo.bin');
    assert.equal(file?.binary, true);
    assert.equal(file?.hunks[0]?.kind, 'binary');
  });

  test('an added file opens on its own, not as a diff against nothing', async () => {
    await repo.reset(BASE);
    repo.write({ 'src/fresh.ts': 'export const fresh = true;\n' });
    await review();

    await openFile('src/fresh.ts');

    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputText, 'a plain editor');
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'file');
  });

  test('a deleted file is marked deleted and opens as a diff titled so', async () => {
    await repo.reset(BASE);
    repo.remove('src/clock.ts');
    await review();

    assert.match(await sidebar(), /clock\.ts — .*deleted/);
    await openFile('src/clock.ts');
    await waitFor(() => activeTab() === 'clock.ts (deleted)', `the deleted file's diff, not "${activeTab()}"`);
  });

  test('a renamed file opens as a diff titled old → new', async () => {
    await repo.reset(BASE);
    repo.git('mv', 'src/clock.ts', 'src/time.ts');
    const api = await review();

    const file = api.host.active?.files.find((f) => f.path === 'src/time.ts');
    assert.equal(file?.status, 'renamed');
    assert.equal(file?.oldPath, 'src/clock.ts');
    await openFile('src/time.ts');
    await waitFor(() => activeTab() === 'clock.ts → time.ts', `the rename's diff, not "${activeTab()}"`);
  });

  test('a working tree review edits the real file; a commit review reads both sides from git', async () => {
    await repo.reset(BASE);
    repo.write({ 'src/token.ts': BASE['src/token.ts'].replace('<', '<=') });
    await review();
    await openFile('src/token.ts');
    assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'file');

    repo.commit('fix expiry');
    void vscode.commands.executeCommand('jury.reviewCommit');
    await pick(0);
    const session = await loaded('commit');
    await openFile('src/token.ts');
    const after = vscode.window.activeTextEditor!.document.uri;
    assert.equal(after.scheme, 'jury');
    assert.equal(revOf(after), session.head);
  });

  test('opening another review replaces the one open, and its grouping never lands', async () => {
    await repo.reset(BASE);
    repo.write({
      'src/clock.ts': BASE['src/clock.ts'].replace('Date.now()', 'performance.now()'),
      'src/token.ts': BASE['src/token.ts'].replace('<', '<='),
      'test/token.test.ts': BASE['test/token.test.ts'] + 'expired(1, 1);\n',
    });
    repo.git('add', 'src/token.ts');
    fake.reply('organise code reviews', undefined, { delayMs: 2_000 });
    const api = await review();
    const first = api.host.active!;
    await waitFor(() => fake.calls().some((c) => c.system.includes('organise code reviews')), 'grouping to be asked for');

    await review('jury.reviewStaged');
    await settle(2_500);

    assert.equal(api.host.active?.spec.kind, 'staged');
    assert.equal(first.clustered, false, 'the replaced review was not grouped');
    assert.doesNotMatch(await sidebar(), /Fake cohort/);
  });

  test('closing the review empties the sidebar', async () => {
    await repo.reset(BASE);
    repo.write({ 'src/token.ts': BASE['src/token.ts'].replace('<', '<=') });
    const api = await review();

    await vscode.commands.executeCommand('jury.close');

    assert.equal(api.host.active, null);
    assert.equal(await sidebar(), '');
  });
});

suite('review this branch', () => {
  test('against the trunk it shows only what the branch added', async () => {
    fake.reset();
    await repo.reset(BASE);
    repo.git('checkout', '-q', '-b', 'feature');
    repo.write({ 'src/token.ts': BASE['src/token.ts'].replace('<', '<=') });
    repo.commit('fix expiry');
    repo.git('checkout', '-q', 'main');
    repo.write({ 'src/clock.ts': BASE['src/clock.ts'].replace('Date.now()', 'performance.now()') });
    repo.commit('main moves on');
    repo.git('checkout', '-q', 'feature');

    void vscode.commands.executeCommand('jury.reviewBase');
    await pick(0);

    const session = await loaded('range');
    assert.equal(session.title, 'main...HEAD');
    assert.deepEqual(session.files.map((f) => f.path), ['src/token.ts']);
  });
});

suite('review a commit', () => {
  test('a root commit reads against the empty tree', async () => {
    await repo.reset({ 'a.ts': 'one\n', 'b.ts': 'two\n' });

    void vscode.commands.executeCommand('jury.reviewCommit');
    await pick(0);

    const session = await loaded('commit');
    assert.equal(session.base, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    assert.deepEqual(
      session.files.map((f) => [f.path, f.status]),
      [
        ['a.ts', 'added'],
        ['b.ts', 'added'],
      ],
    );
  });

  test('a merge commit shows what merging brought in', async () => {
    await repo.reset({ 'a.ts': 'one\n', 'b.ts': 'two\n' });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.write({ 'a.ts': 'one, edited on the branch\n' });
    repo.commit('branch work');
    repo.git('checkout', '-q', 'main');
    repo.write({ 'b.ts': 'two, edited on main\n' });
    repo.commit('main work');
    repo.git('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');

    void vscode.commands.executeCommand('jury.reviewCommit');
    await pick(0);

    const session = await loaded('commit');
    assert.equal(session.spec.kind === 'commit' && session.spec.subject, 'merge feature');
    assert.deepEqual(session.files.map((f) => f.path), ['a.ts']);
  });

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
