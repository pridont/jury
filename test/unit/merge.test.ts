import { describe, expect, it } from 'vitest';
import { merge, unlabel } from '../../src/model/merge.js';
import type { Hunk } from '../../src/model/types.js';

const hunk = (id: string, path: string): Hunk => ({
  id,
  path,
  oldStart: 1,
  oldCount: 1,
  newStart: 1,
  newCount: 1,
  lines: ['+x'],
  stats: { added: 1, removed: 0 },
  kind: 'text',
});

const labels = (paths: string[]) =>
  new Map(paths.map((path, index) => [`h${index + 1}`, hunk(`id${index + 1}`, path)]));

const cohort = (title: string, hunks: string[], over: Record<string, unknown> = {}) => ({
  id: 'c',
  title,
  summary: 's',
  kind: 'feature',
  risk: 'low',
  layers: [{ id: 'l', title: 'l', summary: '', hunks }],
  ...over,
});

const everyHunk = (result: ReturnType<typeof merge>) => {
  if (!result.ok) throw new Error(`declined: ${result.reason}`);
  return result.merged.cohorts.flatMap((c) => c.layers.flatMap((l) => l.hunkIds));
};

describe('merge', () => {
  const four = labels(['a.ts', 'b.ts', 'c.ts', 'd.ts']);

  it('turns a well-formed answer into a stack', () => {
    const result = merge(
      { summary: 'a change', cohorts: [cohort('First', ['h1', 'h2']), cohort('Second', ['h3', 'h4'])], notes: ['n'] },
      four,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.merged.cohorts.map((c) => c.title)).toEqual(['First', 'Second']);
    expect(result.merged.notes).toEqual(['n']);
  });

  it('claims every hunk exactly once, whatever it is given', () => {
    for (const output of [
      { cohorts: [cohort('A', ['h1', 'h2']), cohort('B', ['h3', 'h4'])] },
      { cohorts: [cohort('A', ['h1', 'h1', 'h2']), cohort('B', ['h2', 'h3', 'h4'])] },
      { cohorts: [cohort('A', ['h1', 'nope', 'h2']), cohort('B', ['h3', 'h4', 'h99'])] },
      { cohorts: [cohort('A', ['h1', 'h2']), cohort('B', ['h3'])] },
      { cohorts: [cohort('A', ['h1']), cohort('B', ['h2']), cohort('C', ['h3', 'h4'])] },
    ]) {
      const placed = everyHunk(merge(output, four));
      expect(placed.slice().sort()).toEqual(['id1', 'id2', 'id3', 'id4']);
      expect(new Set(placed).size).toBe(placed.length);
    }
  });

  it('collects what the model failed to place rather than losing it', () => {
    const result = merge({ cohorts: [cohort('A', ['h1', 'h2']), cohort('B', ['h3'])] }, four);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const last = result.merged.cohorts.at(-1)!;
    expect(last.kind).toBe('unclassified');
    expect(last.layers[0]!.hunkIds).toEqual(['id4']);
  });

  it('drops an empty layer and an empty cohort', () => {
    const result = merge(
      {
        cohorts: [
          cohort('Real', ['h1', 'h2']),
          { ...cohort('Ghost', []), layers: [{ id: 'l', title: 'x', summary: '', hunks: ['nope'] }] },
          cohort('Also real', ['h3', 'h4']),
        ],
      },
      four,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.merged.cohorts.map((c) => c.title)).not.toContain('Ghost');
  });

  it('does not let the unclassified fallback rescue a non-answer', () => {
    // One cohort plus "everything else" is not organisation, and the fallback exists to keep
    // a real answer complete, not to make a non-answer look like one.
    expect(merge({ cohorts: [cohort('A', ['h1'])] }, four)).toMatchObject({ ok: false });
  });

  it('declines an answer that organised nothing', () => {
    expect(merge({ cohorts: [cohort('Everything', ['h1', 'h2', 'h3', 'h4'])] }, four)).toMatchObject({
      ok: false,
      reason: 'everything was put in one cohort',
    });
  });

  it('declines one cohort per file, which is the grouping the reviewer already had', () => {
    const six = labels(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']);
    const output = { cohorts: [...six.keys()].map((label) => cohort(label, [label])) };
    expect(merge(output, six)).toMatchObject({ ok: false });
  });

  it('accepts many cohorts when they actually span files', () => {
    const six = labels(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']);
    const output = {
      cohorts: [cohort('A', ['h1', 'h2']), cohort('B', ['h3', 'h4']), cohort('C', ['h5', 'h6'])],
    };
    expect(merge(output, six).ok).toBe(true);
  });

  it('declines when most of the diff was never placed', () => {
    const ten = labels(Array.from({ length: 10 }, (_, i) => `f${i}.ts`));
    const output = { cohorts: [cohort('A', ['h1', 'h2']), cohort('B', ['h3'])] };
    expect(merge(output, ten)).toMatchObject({ ok: false });
  });

  it('survives truncated, empty and nonsense output', () => {
    expect(merge({}, four)).toMatchObject({ ok: false });
    expect(merge({ cohorts: [] }, four)).toMatchObject({ ok: false });
    expect(merge({ cohorts: 'not an array' }, four)).toMatchObject({ ok: false });
    expect(merge({ cohorts: [null, 42, 'x'] } as never, four)).toMatchObject({ ok: false });
  });

  it('falls back on an invented kind or risk instead of trusting it', () => {
    const result = merge(
      { cohorts: [cohort('A', ['h1', 'h2'], { kind: 'sparkly', risk: 'catastrophic' }), cohort('B', ['h3', 'h4'])] },
      four,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.merged.cohorts[0]).toMatchObject({ kind: 'change', risk: 'low' });
  });

  it('keeps a risk reason only when the risk is not low', () => {
    const result = merge(
      {
        cohorts: [
          cohort('A', ['h1', 'h2'], { risk: 'high', riskReason: 'breaks callers' }),
          cohort('B', ['h3', 'h4'], { risk: 'low', riskReason: 'noise' }),
        ],
      },
      four,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.merged.cohorts[0]!.riskReason).toBe('breaks callers');
    expect(result.merged.cohorts[1]!.riskReason).toBeUndefined();
  });

  it('moves generated and docs cohorts to the end, whatever order was asked for', () => {
    const result = merge(
      {
        cohorts: [
          cohort('Lockfile', ['h1'], { kind: 'generated' }),
          cohort('Readme', ['h2'], { kind: 'docs' }),
          cohort('The actual change', ['h3', 'h4'], { kind: 'fix' }),
        ],
      },
      four,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.merged.cohorts.map((c) => c.kind)).toEqual(['fix', 'generated', 'docs']);
  });

  it('appends scaffolding after everything, out of the reading order', () => {
    const generated = hunk('idlock', 'yarn.lock');
    generated.scaffolding = { reason: 'lockfile' };
    const result = merge({ cohorts: [cohort('A', ['h1', 'h2']), cohort('B', ['h3', 'h4'])] }, four, [generated]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.merged.cohorts.at(-1)!.kind).toBe('scaffolding');
  });

  it('records the paths a layer touches, since a layer spans files', () => {
    const result = merge({ cohorts: [cohort('A', ['h1', 'h2']), cohort('B', ['h3', 'h4'])] }, four);
    if (!result.ok) throw new Error(result.reason);
    expect(result.merged.cohorts[0]!.layers[0]!.paths).toEqual(['a.ts', 'b.ts']);
  });
});

describe('unlabel', () => {
  const names = new Map([
    ['h1', 'auth/token.ts'],
    ['h2', 'http/server.ts'],
  ]);

  it('replaces a label that leaked into prose with the file it stands for', () => {
    expect(unlabel('h1 is unrelated to h2', names)).toBe('auth/token.ts is unrelated to http/server.ts');
  });

  it('leaves a label it does not know alone rather than inventing one', () => {
    expect(unlabel('h9 is a mystery', names)).toBe('h9 is a mystery');
  });

  it('does not maul ordinary words that merely contain an h', () => {
    expect(unlabel('the hash h1 uses', names)).toBe('the hash auth/token.ts uses');
    expect(unlabel('width=h1000px', names)).toBe('width=h1000px');
  });
});
