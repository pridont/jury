import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { dialogs, fake, jury, repo, sidebar, waitFor } from './harness.js';

const lines = (name: string) => Array.from({ length: 6 }, (_, i) => `export const ${name}${i + 1} = ${i + 1};`).join('\n') + '\n';

const TOUR = {
  summary: 'Types first, then the code that reads them.',
  diagram: 'flowchart TD\n  core["Core"] --> ui["UI"]',
  steps: [
    { area: 'Core', title: 'The types', summary: 'What everything holds.', spans: [{ path: 'src/types.ts', start: 1, end: 2 }] },
    { area: 'Core', title: 'The ids', summary: 'How they are named.', spans: [{ path: 'src/types.ts', start: 4, end: 5 }] },
    { area: 'UI', title: 'The tree', summary: 'Where they are shown.', spans: [{ path: 'src/ui/tree.ts', start: 1, end: 3 }] },
  ],
};

const asked = () => fake.calls().filter((call) => call.system.includes('guided tour'));

suite('tour', () => {
  test('a tour of one folder opens grouped into areas, with its picture', async () => {
    fake.reset();
    await repo.reset({ 'src/types.ts': lines('t'), 'src/ui/tree.ts': lines('u'), 'docs/notes.md': '# notes\n' });
    fake.reply('guided tour', JSON.stringify(TOUR));
    const api = await jury();

    dialogs.choose(/^src$/);
    await vscode.commands.executeCommand('jury.tour');
    const session = await waitFor(
      () => (api.host.active?.spec.kind === 'trail' && !api.host.active.loading ? api.host.active : null),
      'the tour',
    );

    // Asked once, about the folder picked, with the repository's read-only tools.
    assert.equal(asked().length, 1);
    assert.match(asked()[0]!.input, /^Tour: the folder src\/$/m);
    assert.match(asked()[0]!.args.join(' '), /--tools \S*Read/);

    assert.equal(session.title, 'Tour of src/');
    assert.equal(session.diagram, TOUR.diagram);
    assert.equal(session.overview, TOUR.summary);
    assert.equal(
      await sidebar(),
      [
        '[ ] 1. Core — 0/2 · 1 file · 2 spans',
        '  [ ] The types — 0/1 · src/types.ts · 1 span',
        '  [ ] The ids — 0/1 · src/types.ts · 1 span',
        '[ ] 2. UI: The tree — 0/1 · src/ui/tree.ts · 1 span',
      ].join('\n'),
    );
  });
});
