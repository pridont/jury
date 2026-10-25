import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { configure, fake, repo, review, waitFor } from './harness.js';

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
    // lens's hover, which this command does not hand back.
    assert.deepEqual(await steps('src/c.ts'), [[0, '2. Tests — Cover the boundary. …']]);
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
