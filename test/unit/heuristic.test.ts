import { describe, expect, it } from 'vitest';
import { heuristicCohorts, isTest, stem } from '../../src/model/heuristic.js';
import type { FileChange } from '../../src/git/parse.js';

let counter = 0;
const file = (path: string, over: Partial<FileChange> = {}): FileChange => {
  counter += 1;
  return {
    path,
    status: 'modified',
    binary: false,
    hunks: [
      {
        id: `h${counter}`,
        path,
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: ['+x'],
        stats: { added: 1, removed: 0 },
        kind: 'text',
      },
    ],
    stats: { added: 1, removed: 0 },
    ...over,
  };
};

const scaffold = (path: string): FileChange => {
  const f = file(path);
  f.hunks[0]!.scaffolding = { reason: 'lockfile' };
  return f;
};

describe('stem', () => {
  it('strips the extension and the test marker', () => {
    expect(stem('src/auth/token.spec.ts')).toBe('src/auth/token');
    expect(stem('src/auth/token.test.ts')).toBe('src/auth/token');
    expect(stem('pkg/token_test.go')).toBe('pkg/token');
    expect(stem('tests/test_token.py')).toBe('test_token');
  });

  it('folds a mirrored test directory onto the source stem', () => {
    expect(stem('__tests__/token.ts')).toBe('token');
  });
});

describe('isTest', () => {
  it('recognises the usual shapes', () => {
    for (const path of ['a.spec.ts', 'a.test.tsx', 'test/a.rb', 'tests/a.rb', '__tests__/a.js', 'pkg/a_test.go', 'src/FooTest.java']) {
      expect(isTest(path), path).toBe(true);
    }
  });

  it('does not mistake ordinary code for a test', () => {
    for (const path of ['src/latest.ts', 'src/contest/index.ts', 'protest.md']) {
      expect(isTest(path), path).toBe(false);
    }
  });
});

describe('heuristicCohorts', () => {
  it('puts a test in the same cohort as its source, source first', () => {
    const cohorts = heuristicCohorts([file('src/auth/token.spec.ts'), file('src/auth/token.ts')]);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]!.layers.map((l) => l.title)).toEqual(['src/auth/token.ts', 'src/auth/token.spec.ts']);
    expect(cohorts[0]!.title).toBe('src/auth/token.ts and its test');
  });

  it('pairs a mirrored test tree by basename', () => {
    const cohorts = heuristicCohorts([file('tests/cache_spec.lua'), file('lua/agent/cache.lua')]);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]!.layers.map((l) => l.title)).toEqual(['lua/agent/cache.lua', 'tests/cache_spec.lua']);
  });

  it('refuses an ambiguous basename rather than guessing wrong', () => {
    const cohorts = heuristicCohorts([
      file('tests/index_spec.ts'),
      file('a/index.ts'),
      file('b/index.ts'),
    ]);
    expect(cohorts).toHaveLength(3);
    expect(cohorts.find((c) => c.kind === 'test')!.layers).toHaveLength(1);
  });

  it('leaves an orphan test as its own cohort', () => {
    const cohorts = heuristicCohorts([file('src/nothing.spec.ts')]);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]!.kind).toBe('test');
  });

  it('orders code before config before tests before docs', () => {
    const cohorts = heuristicCohorts([
      file('README.md'),
      file('other.spec.ts'),
      file('config.yml'),
      file('src/app.ts'),
    ]);
    expect(cohorts.map((c) => c.kind)).toEqual(['change', 'config', 'test', 'docs']);
  });

  it('sends scaffolding to the end as one collapsed cohort', () => {
    const cohorts = heuristicCohorts([scaffold('pnpm-lock.yaml'), scaffold('dist/a.js'), file('src/app.ts')]);
    expect(cohorts).toHaveLength(2);
    const last = cohorts[cohorts.length - 1]!;
    expect(last.kind).toBe('scaffolding');
    expect(last.title).toBe('Scaffolding · 2 files');
    expect(last.layers).toHaveLength(2);
  });

  it('claims every hunk exactly once', () => {
    const files = [file('src/a.ts'), file('src/a.spec.ts'), file('src/b.ts'), scaffold('yarn.lock')];
    const cohorts = heuristicCohorts(files);
    const claimed = cohorts.flatMap((c) => c.layers.flatMap((l) => l.hunkIds));
    const expected = files.flatMap((f) => f.hunks.map((h) => h.id));
    expect(claimed.slice().sort()).toEqual(expected.slice().sort());
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('does not claim to know intent it cannot know', () => {
    const cohorts = heuristicCohorts([file('src/app.ts')]);
    expect(cohorts[0]!.kind).toBe('change');
    expect(cohorts[0]!.risk).toBe('low');
    expect(cohorts[0]!.origin).toBe('heuristic');
  });

  it('is empty for an empty diff', () => {
    expect(heuristicCohorts([])).toEqual([]);
  });
});
