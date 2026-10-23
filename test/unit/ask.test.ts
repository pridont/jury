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
const order = buildOrder([cohort], files);
const entry = order[0]!;

describe('askContext', () => {
  it('sends only the hunk, or its step, outside a cohort question', () => {
    expect(askContext(entry, 'hunk', order, 0)).toContain('+alpha');
    const step = askContext(entry, 'step', order, 100_000);
    expect(step).toContain('Step 1: Types');
    expect(step).toContain('+alpha');
    expect(step).not.toContain('Wiring');

    const wiring = askContext(order[1]!, 'step', order, 100_000);
    expect(wiring).toContain('+gamma');
    expect(wiring).toContain('betabeta');
  });

  it('sends every layer and hunk of the cohort when it fits', () => {
    const text = askContext(entry, 'cohort', order, 100_000);
    expect(text).toContain('Step 1: Types');
    expect(text).toContain('Step 2: Wiring');
    expect(text).toContain('Files: b.ts, c.ts');
    expect(text).toContain('+gamma');
    expect(text).not.toContain('not shown');
  });

  it('names the hunks past the budget instead of dropping them', () => {
    const text = askContext(entry, 'cohort', order, 500);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).toContain('+alpha');
    expect(text).toContain('+gamma');
    expect(text).not.toContain('betabeta');
    expect(text).toContain('Hunk in b.ts: @@ -1,1 +1,1 @@ (1 added, 0 removed, not shown)');
    expect(text).toContain('1 hunk is not shown');
  });

  it('shows the hunk being read before any other, and stays within the budget', () => {
    const first = hunk('h1', 'one.ts', 'first'.repeat(100));
    const second = hunk('h2', 'two.ts', 'second'.repeat(100));
    const both = [first, second].map((h) => ({ path: h.path, hunks: [h] }) as unknown as FileChange);
    const big: Cohort = {
      ...cohort,
      layers: [{ id: 'l1', title: 'Both', summary: 'Two.', hunkIds: ['h1', 'h2'], paths: ['one.ts', 'two.ts'] }],
    };
    const bigOrder = buildOrder([big], both);
    const text = askContext(bigOrder[1]!, 'cohort', bigOrder, 1100);
    expect(text.length).toBeLessThanOrEqual(1100);
    expect(text).toContain('secondsecond');
    expect(text).not.toContain('firstfirst');
  });

  it('shows the hunk being read even when nothing fits', () => {
    const text = askContext(order[1]!, 'cohort', order, -1);
    expect(text).toContain('betabeta');
    expect(text).not.toContain('+alpha');
    expect(text).not.toContain('+gamma');
  });
});
