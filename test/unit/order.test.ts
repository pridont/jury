import { describe, expect, it } from 'vitest';
import { buildOrder, layerEntry, step, stepLayer } from '../../src/model/order.js';
import { heuristicCohorts } from '../../src/model/heuristic.js';
import type { FileChange } from '../../src/git/parse.js';
import type { Hunk } from '../../src/model/types.js';

let counter = 0;
const hunk = (path: string): Hunk => {
  counter += 1;
  return {
    id: `h${counter}`,
    path,
    oldStart: counter,
    oldCount: 1,
    newStart: counter,
    newCount: 1,
    lines: ['+x'],
    stats: { added: 1, removed: 0 },
    kind: 'text' as const,
  };
};

const file = (path: string, hunks = 1, scaffolding = false): FileChange => {
  const list = Array.from({ length: hunks }, () => hunk(path));
  if (scaffolding) for (const h of list) h.scaffolding = { reason: 'lockfile' };
  return {
    path,
    status: 'modified',
    binary: false,
    hunks: list,
    stats: { added: hunks, removed: 0 },
  };
};

describe('buildOrder', () => {
  it('flattens cohorts, layers and files into one reading order', () => {
    const files = [file('src/a.ts', 2), file('src/a.spec.ts', 1)];
    const order = buildOrder(heuristicCohorts(files), files);

    expect(order).toHaveLength(3);
    expect(order.map((e) => e.file.path)).toEqual(['src/a.ts', 'src/a.ts', 'src/a.spec.ts']);
    expect(order.map((e) => e.layerIndex)).toEqual([0, 0, 1]);
  });

  it('ignores a hunk id no file claims, rather than producing a broken entry', () => {
    const files = [file('src/a.ts')];
    const cohorts = heuristicCohorts(files);
    cohorts[0]!.layers[0]!.hunkIds.push('does-not-exist');
    expect(buildOrder(cohorts, files)).toHaveLength(1);
  });

  it('marks scaffolding entries', () => {
    const files = [file('src/a.ts'), file('yarn.lock', 1, true)];
    const order = buildOrder(heuristicCohorts(files), files);
    expect(order.map((e) => e.scaffolding)).toEqual([false, true]);
  });
});

describe('step', () => {
  const files = [file('src/a.ts', 2), file('src/b.ts', 1), file('yarn.lock', 2, true)];
  const order = buildOrder(heuristicCohorts(files), files);

  it('crosses file and cohort boundaries on its own', () => {
    expect(order[0]!.file.path).toBe('src/a.ts');
    const second = step(order, 0, 1);
    expect(order[second]!.file.path).toBe('src/a.ts');
    const third = step(order, second, 1);
    expect(order[third]!.file.path).toBe('src/b.ts');
    expect(order[third]!.cohortIndex).not.toBe(order[second]!.cohortIndex);
  });

  it('skips scaffolding from outside it', () => {
    const last = order.findIndex((e) => e.file.path === 'src/b.ts');
    expect(step(order, last, 1)).toBe(last);
  });

  it('walks scaffolding normally once inside it', () => {
    const first = order.findIndex((e) => e.scaffolding);
    expect(step(order, first, 1)).toBe(first + 1);
  });

  it('stops at the ends rather than wrapping', () => {
    expect(step(order, 0, -1)).toBe(0);
    expect(step(order, order.length - 1, 1)).toBe(order.length - 1);
  });
});

describe('stepLayer', () => {
  it('moves to the next layer, not the next hunk', () => {
    const files = [file('src/a.ts', 3), file('src/a.spec.ts', 1)];
    const order = buildOrder(heuristicCohorts(files), files);
    const next = stepLayer(order, 0, 1);
    expect(order[next]!.layerIndex).toBe(1);
    expect(order[next]!.file.path).toBe('src/a.spec.ts');
  });

  it('stays put when there is no further layer', () => {
    const files = [file('src/a.ts', 2)];
    const order = buildOrder(heuristicCohorts(files), files);
    expect(stepLayer(order, 0, 1)).toBe(0);
  });
});

describe('layerEntry', () => {
  const files = [file('src/a.ts', 3)];
  const order = buildOrder(heuristicCohorts(files), files);

  it('lands on the first unread hunk', () => {
    const read = new Set([order[0]!.hunk.id]);
    expect(layerEntry(order, 0, 0, (id) => read.has(id))).toBe(1);
  });

  it('falls back to the first hunk when the layer is fully read', () => {
    expect(layerEntry(order, 0, 0, () => true)).toBe(0);
  });

  it('is -1 for a layer that is not there', () => {
    expect(layerEntry(order, 9, 9, () => false)).toBe(-1);
  });
});
