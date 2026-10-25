import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { configure, documentText, fake, repo, review, settle, waitFor } from './harness.js';

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
      risk: 'high',
      riskReason: 'every session check goes through it',
      layers: [{ id: 'c1l1', title: 'Compare', summary: '', hunks: ['h1', 'h2'] }],
    },
    {
      id: 'c2',
      title: 'Tests',
      summary: '',
      kind: 'test',
      risk: 'low',
      layers: [{ id: 'c2l1', title: 'Cover it', summary: '', hunks: ['h3'] }],
    },
  ],
  notes: ['Nothing migrates existing sessions.'],
  diagram: 'flowchart TD\n  a[check] --> b[expire]',
});

/** The walkthrough once it says `marker`: the document is reused, so it can still hold the last one. */
async function walkthrough(marker: string): Promise<string> {
  await waitFor(() => documentText('Walkthrough.md').includes(marker), `a walkthrough saying "${marker}"`);
  return documentText('Walkthrough.md');
}

const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));

suite('walkthrough', () => {
  setup(async () => {
    fake.reset();
    await repo.reset(BASE);
    repo.write(EDITED);
  });

  test('opens by itself once the grouping lands, and reads in the reading order', async () => {
    const undo = await configure({ 'walkthrough.autoOpen': true });
    fake.reply('organise code reviews', ANSWER);
    try {
      await review('jury.review', { clustered: true });
    } finally {
      await undo();
    }

    const text = await walkthrough('Tokens now expire');
    assert.match(text, /^# working tree\n\n2 changes · 3 hunks · 3 files\n\nTokens now expire on the second they are due\.\n/);
    assert.match(
      text,
      /## Read in this order\n\n1\. \*\*Expiry check\*\* \*\*\(high risk\)\*\* — The comparison is inclusive\.\n\n {3}every session check goes through it\n2\. \*\*Tests\*\* — no summary\n/,
    );
    assert.match(text, /## Worth your attention\n\n- Nothing migrates existing sessions\./);
    const drawable = ['vscode.mermaid-markdown-features', 'bierner.markdown-mermaid'].some((id) =>
      vscode.extensions.getExtension(id),
    );
    if (drawable) assert.match(text, /```mermaid\nflowchart TD\n {2}a\[check\] --> b\[expire\]\n```/);
    else assert.match(text, /Install \[Markdown Preview Mermaid Support\]/);
  });

  test('says under a cohort where its code is not as the author described it', async () => {
    const answer = JSON.parse(ANSWER);
    answer.cohorts[0].mismatch = 'Called a refactor, but expiry now rejects equal times.';
    fake.reply('organise code reviews', JSON.stringify(answer));
    await review('jury.review', { clustered: true });
    await vscode.commands.executeCommand('jury.walkthrough');

    const text = await walkthrough('Not as described');
    assert.match(
      text,
      /1\. \*\*Expiry check\*\*.*\n\n {3}every session check goes through it\n\n {3}\*\*Not as described:\*\* Called a refactor, but expiry now rejects equal times\.\n2\. /,
    );
  });

  test('stays closed when jury.walkthrough.autoOpen is off', async () => {
    // The previous test's preview can open after its editors were closed.
    await settle();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await review('jury.review', { clustered: true });
    await settle();

    assert.ok(!tabs().some((label) => label.includes('Walkthrough')), tabs().join(', '));
  });

  test('without a model it says the review is grouped by file', async () => {
    const undo = await configure({ 'ai.enabled': false });
    try {
      await review();
      await vscode.commands.executeCommand('jury.walkthrough');
    } finally {
      await undo();
    }

    const text = await walkthrough('Grouped by file');
    assert.match(text, /_Grouped by file, in the order git produced them — no model has organised this\._/);
    assert.match(text, /1\. \*\*.*a\.ts\*\*/);
  });

  test('ends by saying how many generated files are left out', async () => {
    await repo.reset({ ...BASE, 'yarn.lock': 'a\n' });
    repo.write({ ...EDITED, 'yarn.lock': 'b\n' });
    await review('jury.review', { clustered: true });

    await vscode.commands.executeCommand('jury.walkthrough');

    const text = await walkthrough('Fake walkthrough summary.');
    assert.match(text, /_1 generated file is not part of the review\._/);
  });
});
