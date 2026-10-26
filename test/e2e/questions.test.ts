import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { configure, dialogs, documentText, fake, repo, review, row, settle, waitFor } from './harness.js';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

const PATHS = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
const BASE = Object.fromEntries(PATHS.map((p) => [p, lines(5)]));
const EDITED = Object.fromEntries(PATHS.map((p) => [p, lines(5).replace('line 3', 'line 3 edited')]));

const GROUPING = JSON.stringify({
  summary: 'Tokens now expire on the second they are due.',
  cohorts: [
    {
      id: 'c1',
      title: 'Expiry check',
      summary: 'The comparison is inclusive.',
      kind: 'fix',
      risk: 'low',
      layers: [{ id: 'c1l1', title: 'Compare', summary: '', hunks: ['h1', 'h2'] }],
    },
    {
      id: 'c2',
      title: 'Tests',
      summary: 'Cover it.',
      kind: 'test',
      risk: 'low',
      layers: [{ id: 'c2l1', title: 'Cover it', summary: '', hunks: ['h3'] }],
    },
  ],
  notes: [],
});

// The answer as a model might give it: one good question, and one of each kind that is dropped.
const QUESTIONS = JSON.stringify({
  cohorts: [
    {
      id: 'c1',
      questions: [
        { perspective: 'caller', question: 'What does isExpired return when exp equals now?' },
        { perspective: 'tester', question: 'Is this a bug?' },
        { perspective: 'operator', question: 'Which clock does production use' },
        { perspective: '', question: 'Where is now read?' },
      ],
    },
  ],
});

const QUESTION_PASS = 'prepare a reviewer to read a change';

const tooltip = (item: vscode.TreeItem) =>
  typeof item.tooltip === 'string' ? item.tooltip : (item.tooltip?.value ?? '');

suite('questions to check', () => {
  setup(async () => {
    fake.reset();
    await repo.reset(BASE);
    repo.write(EDITED);
  });

  test('land under the cohort in the tooltip and the walkthrough, without the ones that are not questions', async () => {
    fake.reply('organise code reviews', GROUPING);
    fake.reply(QUESTION_PASS, QUESTIONS);
    const api = await review('jury.review', { clustered: true });
    await waitFor(() => api.host.active?.cohorts[0]?.questions, 'the questions to land');

    const asked = fake.calls().filter((call) => call.system.includes(QUESTION_PASS));
    assert.equal(asked.length, 1, 'one call for every cohort');
    assert.match(asked[0]!.input, /# Cohort c1\nChange being reviewed: Expiry check/);
    assert.match(asked[0]!.input, /# Cohort c2\nChange being reviewed: Tests/);

    const expected = '*Caller:* What does isExpired return when exp equals now?';
    assert.equal(
      tooltip((await row(/Expiry check/)).item),
      `The comparison is inclusive.\n\nCheck while reading:\n\n- ${expected}`,
    );
    assert.equal(tooltip((await row(/Tests/)).item), 'Cover it.');

    await vscode.commands.executeCommand('jury.walkthrough');
    await waitFor(() => documentText('Walkthrough.md').includes('Check while reading'), 'questions in the walkthrough');
    assert.match(
      documentText('Walkthrough.md'),
      /1\. \*\*\[Expiry check\]\(\S+\)\*\* — The comparison is inclusive\.\n\n {3}Check while reading:\n {3}- \*Caller:\* What does isExpired return when exp equals now\?\n2\. /,
    );
  });

  test('a picked question opens a note on the cohort\'s first hunk, quoting it', async () => {
    fake.reply('organise code reviews', GROUPING);
    fake.reply(QUESTION_PASS, QUESTIONS);
    const api = await review('jury.review', { clustered: true });
    await waitFor(() => api.host.active?.cohorts[0]?.questions, 'the questions to land');

    const { node } = await row(/Expiry check/);
    dialogs.choose(/exp equals now/);
    await vscode.commands.executeCommand('jury.answerQuestion', node);

    const session = api.host.active!;
    const note = await waitFor(() => session.comments[0], 'a note to be started');
    assert.equal(note.body, '> What does isExpired return when exp equals now? (caller)\n\n');
    const first = session.cohorts[0]!.layers[0]!.hunkIds[0];
    assert.equal(note.hunkId, first);
    assert.equal(api.nav.current?.hunk.id, first);
  });

  test('jury.ai.questions off asks for none', async () => {
    const undo = await configure({ 'ai.questions': false });
    try {
      fake.reply('organise code reviews', GROUPING);
      await review('jury.review', { clustered: true });
      await settle();
    } finally {
      await undo();
    }
    assert.equal(fake.calls().filter((call) => call.system.includes(QUESTION_PASS)).length, 0);
  });
});
