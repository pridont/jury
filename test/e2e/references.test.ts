import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { fake, jury, pick, repo, waitFor } from './harness.js';

const LIB = 'export function helper(): number {\n  return 1;\n}\n\nexport function unused(): number {\n  return 0;\n}\n';
const USE = "import { helper } from './lib';\n\nexport const value = helper();\n";
const OTHER = "import { helper } from './lib';\n\nexport const other = 0;\n";
// Without a project the TypeScript server only knows the files that are open. The folder is
// one no other test uses: the server keeps the project it made for a path earlier in the run.
const TSCONFIG = '{}\n';

suite('uses outside the change', () => {
  test('a changed function counts the callers the diff does not show', async function () {
    // The TypeScript server starts cold in a fresh window.
    this.timeout(90_000);
    fake.reset();
    await repo.reset({ 'callers/tsconfig.json': TSCONFIG, 'callers/lib.ts': LIB, 'callers/use.ts': USE, 'callers/other.ts': OTHER });
    repo.write({
      'callers/lib.ts': LIB.replace('return 1', 'return 2').replace('return 0', 'return -1'),
      'callers/other.ts': OTHER.replace('= 0', '= helper()'),
    });
    repo.commit('change the helper and call it');
    const api = await jury();

    void vscode.commands.executeCommand('jury.reviewCommit');
    await pick(0);
    await waitFor(() => api.host.active?.spec.kind === 'commit' && !api.host.active.loading, 'the commit review');
    const entry = api.nav.entries.find((e) => e.hunk.path === 'callers/lib.ts');
    assert.ok(entry, 'a hunk in callers/lib.ts');
    await api.nav.goToHunk(entry.hunk.id);
    const blob = await waitFor(
      () =>
        vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.scheme === 'jury' && e.document.getText().includes('return 2'),
        )?.document,
      'the new side of lib.ts',
    );

    // other.ts calls helper inside the change; use.ts imports and calls it outside it.
    const expected = [
      [0, '2 uses outside this change · 1 file'],
      [4, 'no uses outside this change'],
    ];
    const titles = async () => {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', blob.uri, 10);
      return (lenses ?? []).map((lens) => [lens.range.start.line, lens.command?.title]).sort();
    };
    await waitFor(
      async () => JSON.stringify(await titles()) === JSON.stringify(expected) || undefined,
      'both lenses counted',
      60_000,
    ).catch(async (error: unknown) => {
      assert.deepEqual(await titles(), expected, String(error));
    });
  });
});
