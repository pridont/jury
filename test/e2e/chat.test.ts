import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { askContext, askPrompt, type AskScope } from '../../src/agent/prompts/ask.js';
import type { Api } from '../../src/extension.js';
import type { Entry } from '../../src/model/order.js';
import { fake, repo, review, waitFor } from './harness.js';

const lines = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n';

// The fake groups files in reverse order, two per cohort: `d.ts` and `c.ts` in one, `b.ts` and
// `a.ts` (two hunks) in the other, one step per file.
const BASE = {
  'src/a.ts': lines(40),
  'src/b.ts': lines(5),
  'src/c.ts': lines(5),
  'src/d.ts': lines(5),
};

// What `@jury` has left for the change once the instructions and the question are paid for,
// out of the 60k-character input budget every provider gets.
const budget = (question: string) => 60_000 - askPrompt.system.length - question.length - '\n\nQuestion: '.length;

/**
 * What `@jury /<scope> <question>` sends the model about the hunk being read. The chat panel
 * cannot be driven headless (no chat setup), so this builds the context the way `@jury` does,
 * from the live review's current hunk and reading order.
 */
const context = (api: Api, scope: AskScope, question = 'what does this do?') =>
  askContext(api.nav.current!, scope, api.nav.entries, budget(question));

async function goTo(api: Api, match: (entry: Entry) => boolean): Promise<Entry> {
  const entry = api.nav.entries.find(match);
  assert.ok(entry, 'the fixture has the hunk the test wants');
  await api.nav.goToHunk(entry.hunk.id);
  await waitFor(() => api.nav.current?.hunk.id === entry.hunk.id, 'the hunk to be current');
  return entry;
}

suite('ask about the change', () => {
  setup(async () => {
    fake.reset();
    await repo.reset(BASE);
    repo.write({
      'src/a.ts': lines(40).replace('line 1\n', 'line 1 edited\n').replace('line 39\n', 'line 39 edited\n'),
      'src/b.ts': lines(5).replace('line 3', 'line 3 edited'),
      'src/c.ts': lines(5).replace('line 3', 'line 3 edited'),
      'src/d.ts': lines(5).replace('line 3', 'line 3 edited'),
    });
  });

  test('@jury offers /step, /cohort and /trail', () => {
    const extension = vscode.extensions.getExtension('pridont.jury')!;
    const participant = extension.packageJSON.contributes.chatParticipants.find(
      (p: { id: string }) => p.id === 'jury.ask',
    );
    assert.deepEqual(
      participant.commands.map((c: { name: string }) => c.name),
      ['step', 'cohort', 'trail'],
    );
  });

  test('/cohort sends every step of the current cohort and no other', async () => {
    const api = await review('jury.review', { clustered: true });
    const entry = await goTo(api, (e) => e.file.path === 'src/b.ts');

    const input = context(api, 'cohort');

    const inCohort = api.nav.entries.filter((e) => e.cohortIndex === entry.cohortIndex);
    assert.equal(new Set(inCohort.map((e) => e.layerIndex)).size, 2, 'the cohort has two steps');
    for (const other of inCohort) {
      assert.ok(input.includes(`Step ${other.layerIndex + 1}: ${other.layer.title}`), `${other.layer.title} is sent`);
      assert.ok(input.includes(`Hunk in ${other.hunk.path}`), `${other.hunk.path} is sent`);
    }
    assert.ok(input.includes('line 1 edited') && input.includes('line 39 edited'), 'both a.ts hunks are shown');
    for (const other of api.nav.entries.filter((e) => e.cohortIndex !== entry.cohortIndex)) {
      assert.ok(!input.includes(`Hunk in ${other.hunk.path}`), `${other.hunk.path} is in another cohort`);
    }
    assert.match(input, /The reviewer is on the hunk in src\/b\.ts:/);
    assert.doesNotMatch(input, /not shown/);
  });

  test('/step sends every hunk of the step', async () => {
    const api = await review('jury.review', { clustered: true });
    const entry = await goTo(api, (e) => e.file.path === 'src/a.ts');

    const input = context(api, 'step');

    assert.ok(input.includes(`Step ${entry.layerIndex + 1}: ${entry.layer.title}\n`), 'the step heading is sent');
    assert.ok(input.includes('line 1 edited') && input.includes('line 39 edited'), 'both hunks are shown');
    assert.ok(!input.includes('Hunk in src/b.ts'), 'the other step in the cohort is left out');
    assert.doesNotMatch(input, /not shown/);
  });

  test('a cohort past the input budget still shows the hunk being read', async () => {
    // Each a.ts hunk alone is ~45k characters, so the two do not fit in the 60k budget together.
    const big = (tag: string) => lines(3_500, tag);
    await repo.reset({ 'src/a.ts': lines(5_000), 'src/b.ts': lines(5) });
    repo.write({
      'src/a.ts': lines(5_000).replace('line 1\n', big('first') + 'line 1\n').replace('line 4999\n', big('last') + 'line 4999\n'),
      'src/b.ts': lines(5).replace('line 3', 'line 3 edited'),
    });
    const api = await review('jury.review', { clustered: true });
    const hunks = api.nav.entries.filter((e) => e.file.path === 'src/a.ts');
    assert.equal(hunks.length, 2, 'a.ts has two hunks');
    await goTo(api, (e) => e === hunks[1]);

    const question = 'what does the last edit do?';
    const input = context(api, 'cohort', question);

    assert.ok(input.includes('last 3500'), 'the hunk being read is shown');
    assert.ok(!input.includes('first 3500'), 'the hunk that does not fit is left out');
    assert.match(input, /\(3500 added, 0 removed, not shown\)/);
    assert.match(input, /1 hunk is not shown/);
    assert.ok(input.length <= budget(question), `input is ${input.length} characters`);
  });
});
