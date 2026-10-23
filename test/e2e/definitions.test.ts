import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { fake, jury, pick, repo, waitFor } from './harness.js';

const LIB = 'export function helper(): number {\n  return 1;\n}\n';
const USE = "import { helper } from './lib';\n\nexport const value = 0;\n";

suite('go to definition', () => {
  test('from a side of the diff git serves, it lands in the working tree', async function () {
    // The TypeScript server starts cold in a fresh window.
    this.timeout(90_000);
    fake.reset();
    await repo.reset({ 'src/lib.ts': LIB, 'src/use.ts': USE });
    repo.write({ 'src/use.ts': USE.replace('= 0', '= helper()') });
    repo.commit('use the helper');
    const api = await jury();

    void vscode.commands.executeCommand('jury.reviewCommit');
    await pick(0);
    await waitFor(() => api.host.active?.spec.kind === 'commit' && !api.host.active.loading, 'the commit review');
    await api.nav.goToHunk(api.nav.entries[0]!.hunk.id);
    const blob = await waitFor(
      () => vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'jury' && e.document.getText().includes('helper()'))?.document,
      'the new side of use.ts',
    );
    const at = new vscode.Position(2, blob.lineAt(2).text.indexOf('helper'));

    const target = await waitFor(
      async () => {
        const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
          'vscode.executeDefinitionProvider',
          blob.uri,
          at,
        );
        return found
          ?.map((f) => ('targetUri' in f ? { uri: f.targetUri, range: f.targetRange } : f))
          .find((f) => f.uri.scheme === 'file' && f.uri.path.endsWith('/src/lib.ts'));
      },
      'a definition in src/lib.ts',
      60_000,
    );

    assert.equal(target.range.start.line, 0);
  });
});
