import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { configure, fake, repo, review, row, waitFor } from './harness.js';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const PATHS = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
const BASE = Object.fromEntries(PATHS.map((p) => [p, lines(5)]));
const EDITED = Object.fromEntries(PATHS.map((p) => [p, lines(5).replace('line 3', 'line 3 edited')]));

const ANSWER = JSON.stringify({
  summary: 'Tokens now expire on the second they are due.',
  cohorts: [
    {
      id: 'c1',
      title: 'Expiry check',
      summary: 'The comparison is inclusive.',
      kind: 'fix',
      risk: 'low',
      mismatch: 'Called a refactor, but expiry now rejects equal times.',
      layers: [{ id: 'c1l1', title: 'Compare', summary: '', hunks: ['h1', 'h2'] }],
    },
    {
      id: 'c2',
      title: 'Tests',
      summary: 'Cover the boundary. Every token that expires on the exact second of the check is now rejected, and the tests pin the clock to prove it.',
      kind: 'test',
      risk: 'low',
      layers: [{ id: 'c2l1', title: 'Cover it', summary: '', hunks: ['h3'] }],
    },
  ],
  notes: [],
});

/** The step lenses on a working-tree file, as [line, title]. */
async function steps(file: string): Promise<[number, string][]> {
  const uri = vscode.Uri.file(path.join(repo.root, file));
  // The command only asks about a document that is open.
  await vscode.workspace.openTextDocument(uri);
  const found = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)) ?? [];
  return found
    .map((lens): [number, string] => [lens.range.start.line, lens.command?.title ?? ''])
    .filter(([, title]) => !title.includes('outside this change'));
}

/** What every hover provider says about a line of a working-tree file. */
async function hover(file: string, line: number): Promise<string> {
  const uri = vscode.Uri.file(path.join(repo.root, file));
  await vscode.workspace.openTextDocument(uri);
  const found = (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, new vscode.Position(line, 0))) ?? [];
  return found.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n\n');
}

suite('step lenses', () => {
  setup(async () => {
    fake.reset();
    await repo.reset(BASE);
    repo.write(EDITED);
  });

  test('each step names itself and says what it is for above its first line', async () => {
    fake.reply('organise code reviews', ANSWER);
    await review('jury.review', { clustered: true });

    // h1 is a.ts's only hunk, and its context starts on line 1.
    await waitFor(async () => (await steps('src/a.ts')).length === 2 || undefined, 'the lenses on a.ts');
    assert.deepEqual(await steps('src/a.ts'), [
      [0, '$(warning) Not as described: Called a refactor, but expiry now rejects equal times.'],
      [0, '1. Expiry check — The comparison is inclusive.'],
    ]);
    // Too long for one line, so the title and the whole sentences that fit. The rest is the
    // hover of the line the lens is on.
    assert.deepEqual(await steps('src/c.ts'), [[0, '2. Tests — Cover the boundary. …']]);
    assert.ok((await hover('src/c.ts', 0)).includes(`2. Tests — ${JSON.parse(ANSWER).cohorts[1].summary}`));
    assert.ok(!(await hover('src/c.ts', 1)).includes('2. Tests'));
  });

  test('a cohort that is not as described has a warning icon on its row', async () => {
    fake.reply('organise code reviews', ANSWER);
    await review('jury.review', { clustered: true });
    // The icon, not the description: a long title pushes the description off a narrow row.
    const flagged = (await row(/Expiry check/)).item;
    assert.equal((flagged.iconPath as vscode.ThemeIcon).id, 'warning');
    assert.match(String(flagged.description), /^not as described · /);
    assert.notEqual(((await row(/Tests/)).item.iconPath as vscode.ThemeIcon | undefined)?.id, 'warning');
  });

  test('a diff editor, which hides lenses, gets the same words after the line', async () => {
    fake.reply('organise code reviews', ANSWER);
    const api = await review('jury.review', { clustered: true });
    const uri = vscode.Uri.file(path.join(repo.root, 'src/a.ts')).toString();
    const entry = api.nav.entries.find((e) => e.hunk.path === 'src/a.ts')!;

    // A modified file opens as a diff; the working tree file is its new side.
    await api.nav.goToHunk(entry.hunk.id);
    const drawn = await waitFor(() => api.steps.drawn.get(uri), 'the text after line 1 of a.ts');
    assert.deepEqual(drawn, [[0, '⚠ Not as described …  ·  1. Expiry check …']]);
    // The text after the line has the whole note as its hover; the line's own would repeat it.
    assert.ok(!(await hover('src/a.ts', 0)).includes('1. Expiry check'));

    // With lenses on in diff editors, the lens says it and the text would say it twice.
    const diffEditor = vscode.workspace.getConfiguration('diffEditor');
    await diffEditor.update('codeLens', true, vscode.ConfigurationTarget.Workspace);
    try {
      await waitFor(() => api.steps.drawn.size === 0 || undefined, 'no text once lenses show');
      assert.ok((await hover('src/a.ts', 0)).includes('1. Expiry check — The comparison is inclusive.'));
    } finally {
      await diffEditor.update('codeLens', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test("in a diff, the text goes after the roomiest of the step's first lines", async () => {
    const LONG = "export const greeting = 'a line long enough to fill most of one side of a diff';\n\nexport function hello() {\n  return greeting;\n}\n";
    await repo.reset({ ...BASE, 'src/long.ts': LONG });
    repo.write({ ...EDITED, 'src/long.ts': LONG.replace('return greeting;', 'return greeting.toUpperCase();') });
    const answer = JSON.parse(ANSWER);
    answer.cohorts.push({
      id: 'c3',
      title: 'Shout the greeting',
      summary: 'hello upper-cases it.',
      kind: 'feature',
      risk: 'low',
      layers: [{ id: 'c3l1', title: 'Shout', summary: '', hunks: ['h4'] }],
    });
    fake.reply('organise code reviews', JSON.stringify(answer));
    const api = await review('jury.review', { clustered: true });
    const uri = vscode.Uri.file(path.join(repo.root, 'src/long.ts')).toString();

    await api.nav.goToHunk(api.nav.entries.find((e) => e.hunk.path === 'src/long.ts')!.hunk.id);
    // The hunk starts at line 1, which is long; line 2 is blank and has the whole pane.
    const drawn = await waitFor(() => api.steps.drawn.get(uri), 'the text in long.ts');
    assert.deepEqual(drawn, [[1, '3. Shout the greeting …']]);
  });

  test('a plain editor gets the lens and no text after the line', async () => {
    fake.reply('organise code reviews', ANSWER);
    const api = await review('jury.review', { clustered: true });
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo.root, 'src/a.ts')));
    await waitFor(async () => (await steps('src/a.ts')).length === 2 || undefined, 'the lenses on a.ts');
    assert.equal(api.steps.drawn.size, 0);
  });

  test('a review no model grouped has no step lenses: its steps are its files', async () => {
    const undo = await configure({ 'ai.enabled': false });
    try {
      await review();
    } finally {
      await undo();
    }
    assert.deepEqual(await steps('src/a.ts'), []);
  });
});
