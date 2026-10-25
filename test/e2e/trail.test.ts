import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { dialogs, fake, jury, repo, sidebar, waitFor } from './harness.js';

const OPEN = 'export function open() {\n  const review = load();\n  show(review);\n  return review;\n}\n';
const STORE = Array.from({ length: 8 }, (_, i) => `export const s${i + 1} = ${i + 1};`).join('\n') + '\n';

const TRAIL = {
  summary: 'A review is saved by store.ts when it is opened.',
  steps: [
    { title: 'Open a review', summary: 'Where it starts.', spans: [{ path: 'src/open.ts', start: 2, end: 4 }] },
    {
      title: 'Save the marks',
      summary: 'Where it lands.',
      spans: [
        { path: 'src/store.ts', start: 3, end: 5 },
        { path: 'src/gone.ts', start: 1, end: 3 },
      ],
    },
    { title: 'Past the end', summary: 'Clamped.', spans: [{ path: 'src/store.ts', start: 7, end: 99 }] },
  ],
};

const QUESTION = 'How does a review get saved?';
const asked = () => fake.calls().filter((call) => call.system.includes('guide a developer through a codebase'));

suite('trail', () => {
  test('a question opens as code to read, in order, and reopens without asking again', async () => {
    fake.reset();
    await repo.reset({ 'src/open.ts': OPEN, 'src/store.ts': STORE });
    fake.reply('guide a developer through a codebase', JSON.stringify(TRAIL));
    const api = await jury();

    dialogs.type(QUESTION);
    await vscode.commands.executeCommand('jury.trail');
    const session = await waitFor(
      () => (api.host.active?.spec.kind === 'trail' && !api.host.active.loading ? api.host.active : null),
      'the trail',
    );

    // Asked with the repository's read-only tools, about the question typed.
    assert.equal(asked().length, 1);
    assert.match(asked()[0]!.input, /Question: How does a review get saved\?/);
    assert.match(asked()[0]!.args.join(' '), /--tools \S*Read/);

    // The steps in the model's order; the missing file is dropped and the long span clamped.
    assert.equal(session.title, QUESTION);
    assert.equal(
      await sidebar(),
      [
        '[ ] 1. Open a review — 0/1 · src/open.ts · 1 span',
        '[ ] 2. Save the marks — 0/1 · src/store.ts · 1 span',
        '[ ] 3. Past the end — 0/1 · src/store.ts · 1 span',
      ].join('\n'),
    );
    const store = session.files.find((f) => f.path === 'src/store.ts')!;
    assert.deepEqual(
      store.hunks.map((h) => [h.newStart, h.newCount]),
      [
        [3, 3],
        [7, 2],
      ],
    );

    // Stepping opens the file itself, not a diff, at the span.
    await vscode.commands.executeCommand('jury.nextHunk');
    const editor = await waitFor(
      () => (vscode.window.activeTextEditor?.document.uri.path.endsWith('/src/open.ts') ? vscode.window.activeTextEditor : null),
      'src/open.ts open',
    );
    assert.equal(editor.document.uri.scheme, 'file');
    assert.equal(editor.selection.active.line, 1);

    await vscode.commands.executeCommand('jury.toggleReviewed');
    await waitFor(() => session.marks.size === 1, 'the first span marked');

    // Reopened from the saved list: the same trail and its mark, and no second question.
    await vscode.commands.executeCommand('jury.close');
    void vscode.commands.executeCommand('jury.resume');
    const again = await waitFor(
      () => (api.host.active?.spec.kind === 'trail' && !api.host.active.loading ? api.host.active : null),
      'the trail again',
    );
    assert.equal(again.cohorts.length, 3);
    assert.equal(again.marks.size, 1);
    assert.equal(asked().length, 1);
  });

  test("a stop's key line is where stepping lands, with the stop's lens on it", async () => {
    fake.reset();
    await repo.reset({ 'src/open.ts': OPEN, 'src/store.ts': STORE });
    fake.reply(
      'guide a developer through a codebase',
      JSON.stringify({
        summary: 'Opening shows the review.',
        steps: [{ title: 'Show it', summary: 'The call that draws it.', spans: [{ path: 'src/open.ts', start: 1, end: 5, focus: 3 }] }],
      }),
    );
    const api = await jury();

    dialogs.type(QUESTION);
    await vscode.commands.executeCommand('jury.trail');
    await waitFor(() => (api.host.active?.spec.kind === 'trail' && !api.host.active.loading ? api.host.active : null), 'the trail');

    await vscode.commands.executeCommand('jury.nextHunk');
    const editor = await waitFor(
      () => (vscode.window.activeTextEditor?.document.uri.path.endsWith('/src/open.ts') ? vscode.window.activeTextEditor : null),
      'src/open.ts open',
    );
    // `show(review);`, not the span's first line.
    assert.equal(editor.selection.active.line, 2);
    const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', editor.document.uri)) ?? [];
    assert.deepEqual(
      lenses.map((lens) => [lens.range.start.line, lens.command?.title]).filter(([, title]) => !String(title).includes('outside this change')),
      [[2, '1. Show it — The call that draws it.']],
    );
  });

  test('an answer with no code in the repository opens nothing', async () => {
    fake.reset();
    await repo.reset({ 'src/open.ts': OPEN });
    fake.reply(
      'guide a developer through a codebase',
      JSON.stringify({ summary: 'S.', steps: [{ title: 'Nowhere', summary: '', spans: [{ path: 'src/gone.ts', start: 1, end: 2 }] }] }),
    );
    const api = await jury();

    dialogs.type(QUESTION);
    await vscode.commands.executeCommand('jury.trail');
    await waitFor(() => api.host.active?.spec.kind === 'trail' && !api.host.active.loading, 'the trail');
    assert.match(api.host.active!.error ?? '', /none of the code this trail points at is in the working tree/);
  });
});
