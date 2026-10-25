import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { configure, dialogs, documentText, fake, jury, repo, review, sidebar, waitFor } from './harness.js';

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
    dialogs.choose(/^Detailed$/);
    await vscode.commands.executeCommand('jury.tour');
    const session = await waitFor(
      () => (api.host.active?.spec.kind === 'trail' && !api.host.active.loading ? api.host.active : null),
      'the tour',
    );

    // Asked once, about the folder picked, on the deep model, with read-only tools.
    assert.equal(asked().length, 1);
    assert.match(asked()[0]!.input, /^Tour: the folder src\/$/m);
    assert.match(asked()[0]!.args.join(' '), /--tools \S*Read/);
    assert.match(asked()[0]!.args.join(' '), /--model opus/);

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

    // An area has no summary of its own: the walkthrough lists its stops with theirs.
    await vscode.commands.executeCommand('jury.walkthrough');
    // Wait for this tour's text: an earlier test's walkthrough may still be open under the same name.
    const text = await waitFor(() => (documentText('Walkthrough.md').includes('# Tour of src/') ? documentText('Walkthrough.md') : ''), 'the walkthrough');
    assert.ok(
      text.includes(
        [
          '1. **Core**',
          '   - **The types** — What everything holds.',
          '   - **The ids** — How they are named.',
          '2. **UI: The tree** — Where they are shown.',
        ].join('\n'),
      ),
      text,
    );
    assert.doesNotMatch(text, /no summary/);
  });

  test('a quick tour of the whole repository asks the faster model', async () => {
    fake.reset();
    await repo.reset({ 'src/types.ts': lines('t'), 'src/ui/tree.ts': lines('u') });
    fake.reply('guided tour', JSON.stringify(TOUR));
    const api = await jury();

    dialogs.choose(/^The whole repository$/);
    dialogs.choose(/^Quick$/);
    await vscode.commands.executeCommand('jury.tour');
    await waitFor(() => api.host.active?.spec.kind === 'trail' && !api.host.active.loading, 'the tour');

    assert.match(asked()[0]!.input, /^Tour: the whole repository$/m);
    assert.match(asked()[0]!.args.join(' '), /--model sonnet/);
  });

  test('a saved tour is the map the grouping model reads a later change against', async () => {
    fake.reset();
    await repo.reset({ 'src/types.ts': lines('t'), 'src/ui/tree.ts': lines('u'), 'src/ids.ts': lines('i') });
    fake.reply('guided tour', JSON.stringify(TOUR));
    const undo = await configure({ 'ai.enabled': true });
    try {
      const api = await jury();
      dialogs.choose(/^src$/);
      dialogs.choose(/^Quick$/);
      await vscode.commands.executeCommand('jury.tour');
      await waitFor(() => api.host.active?.spec.kind === 'trail' && !api.host.active.loading, 'the tour');

      // Three hunks: fewer is not worth grouping, and the model is never asked.
      repo.write({ 'src/types.ts': lines('t2'), 'src/ui/tree.ts': lines('u2'), 'src/ids.ts': lines('i2') });
      await review('jury.review');
      const call = await waitFor(() => fake.calls().find((c) => c.system.includes('organise code reviews')), 'grouping');
      assert.ok(
        call.input.startsWith(
          'How the codebase is organised, from an earlier tour of it:\n<map>\n' +
            `Tour of src/: ${TOUR.summary}\n\nAreas, and the files read for each:\n- Core: src/types.ts\n- UI: src/ui/tree.ts\n\n` +
            `How they fit together:\n${TOUR.diagram}\n</map>\n\n`,
        ),
        call.input,
      );
    } finally {
      await undo();
    }
  });

  test('closing the second question asks nothing', async () => {
    fake.reset();
    await repo.reset({ 'src/types.ts': lines('t') });
    // The folder is picked; the question of how thorough is dismissed.
    dialogs.choose(/^src$/);
    await vscode.commands.executeCommand('jury.tour');
    assert.equal(asked().length, 0);
  });
});
