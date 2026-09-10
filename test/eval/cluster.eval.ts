import { afterAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { Cache } from '../../src/agent/cache.js';
import { Queue } from '../../src/agent/queue.js';
import { clusterChange } from '../../src/agent/cluster.js';
import { ClaudeProvider } from '../../src/agent/providers/claude.js';
import { heuristicGrouping, load, toGrouping, type Fixture } from './harness.js';
import { percent, score, type Score } from './score.js';

/**
 * How good is the clustering, and is it better than doing nothing clever?
 *
 * Cached against the prompt text, so re-running an unchanged prompt is free and editing one
 * invalidates exactly the answers it affects. A prompt change that does not move these
 * numbers did not happen.
 */
const FIXTURES = ['auth-clock', 'two-changes'];
const cache = new Cache(path.resolve('test/eval/.cache'));
const rows: { name: string; model: Score; base: Score }[] = [];

describe('clustering', () => {
  for (const name of FIXTURES) {
    it(name, async () => {
      const fixture = load(name);
      const provider = new ClaudeProvider();
      expect((await provider.available()).ok, 'claude must be available to run the eval').toBe(true);

      const result = await clusterChange(
        { provider, queue: new Queue(2), cache, owner: 'eval', log: () => {} },
        fixture.files,
        new Map(),
      );

      expect(result.ok, result.ok ? '' : `declined: ${result.reason}`).toBe(true);
      if (!result.ok) return;

      const actual = toGrouping(result.merged.cohorts, fixture);
      const base = heuristicGrouping(fixture);

      rows.push({
        name,
        model: score(fixture.expected, actual, fixture.unordered),
        base: score(fixture.expected, base, fixture.unordered),
      });
      report(fixture, result.merged.cohorts.map((c) => `${c.kind}: ${c.title}`), actual);

      // Every label the digest offered has to come back somewhere.
      const placed = actual.flat();
      expect(new Set(placed).size).toBe(placed.length);
      expect(placed.length).toBe(fixture.digest.labels.size);
    });
  }
});

afterAll(() => {
  if (rows.length === 0) return;
  const line = (label: string, get: (row: (typeof rows)[number]) => Score, field: keyof Score) =>
    `${label.padEnd(20)} ${rows.map((row) => percent(get(row)[field] as number).padStart(7)).join('  ')}`;

  console.log(`\n${'fixture'.padEnd(20)} ${rows.map((r) => r.name.padStart(7)).join('  ')}`);
  console.log(line('grouping (model)', (r) => r.model, 'grouping'));
  console.log(line('grouping (heuristic)', (r) => r.base, 'grouping'));
  console.log(line('order (model)', (r) => r.model, 'order'));
  console.log(line('order (heuristic)', (r) => r.base, 'order'));

  for (const row of rows) {
    expect(row.model.grouping, `${row.name}: clustering must beat the heuristic it replaces`).toBeGreaterThanOrEqual(
      row.base.grouping,
    );
  }
});

function report(fixture: Fixture, cohorts: string[], actual: string[][]): void {
  console.log(`\n=== ${fixture.name} ===`);
  cohorts.forEach((title, index) => console.log(`  ${index + 1}. ${title}  [${actual[index]?.join(' ') ?? ''}]`));
}
