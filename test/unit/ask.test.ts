import { describe, expect, it } from 'vitest';
import { askContext } from '../../src/agent/prompts/ask.js';
import { buildOrder } from '../../src/model/order.js';
import type { FileChange } from '../../src/git/parse.js';
import type { Cohort, Hunk } from '../../src/model/types.js';

const hunk = (id: string, path: string, body: string): Hunk => ({
  id,
  path,
  oldStart: 1,
  oldCount: 1,
  newStart: 1,
  newCount: 1,
  lines: [`+${body}`],
  stats: { added: 1, removed: 0 },
  kind: 'text',
});

const a = hunk('ha', 'a.ts', 'alpha');
const b = hunk('hb', 'b.ts', 'beta'.repeat(50));
const c = hunk('hc', 'c.ts', 'gamma');
const files = [a, b, c].map((h) => ({ path: h.path, hunks: [h] }) as unknown as FileChange);

const cohort: Cohort = {
  id: 'c1',
  title: 'Add the thing',
  summary: 'Adds it.',
  kind: 'feature',
  risk: 'low',
  origin: 'ai',
  layers: [
    { id: 'l1', title: 'Types', summary: 'The shape.', hunkIds: ['ha'], paths: ['a.ts'] },
    { id: 'l2', title: 'Wiring', summary: 'The use.', hunkIds: ['hb', 'hc'], paths: ['b.ts', 'c.ts'] },
  ],
};
const entry = buildOrder([cohort], files)[0]!;

describe('askContext', () => {
  it('sends only the hunk, or its step, outside a cohort question', () => {
    const step = askContext(entry, 'step', files, 0);
    expect(step).toContain('Step: Types');
    expect(step).toContain('+alpha');
    expect(step).not.toContain('Wiring');
  });

  it('sends every layer and hunk of the cohort when it fits', () => {
    const text = askContext(entry, 'cohort', files, 100_000);
    expect(text).toContain('Step 1: Types');
    expect(text).toContain('Step 2: Wiring');
    expect(text).toContain('Files: b.ts, c.ts');
    expect(text).toContain('+gamma');
    expect(text).not.toContain('not shown');
  });

  it('names the hunks past the budget instead of dropping them', () => {
    const text = askContext(entry, 'cohort', files, 100);
    expect(text).toContain('+alpha');
    expect(text).toContain('+gamma');
    expect(text).not.toContain('betabeta');
    expect(text).toContain('Hunk in b.ts: @@ -1,1 +1,1 @@ (1 added, 0 removed, not shown)');
    expect(text).toContain('1 hunk is not shown');
  });
});
