import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseDiff, type FileChange } from '../../src/git/parse.js';
import { applyVerdicts, classifyAll, type ClassifyInput } from '../../src/model/noise.js';
import { heuristicCohorts } from '../../src/model/heuristic.js';
import { buildDigest } from '../../src/agent/digest.js';
import type { Cohort } from '../../src/model/types.js';
import type { Grouping, Unordered } from './score.js';

const dir = path.resolve('test/eval/fixtures');

export type Fixture = {
  name: string;
  files: FileChange[];
  digest: ReturnType<typeof buildDigest>;
  /** Hand-written: the groups, in the order a reviewer should read them. */
  expected: Grouping;
  /** Group pairs whose relative order is a coin flip, and so is not scored. */
  unordered: Unordered;
  why: string;
};

/**
 * Load a fixture and prepare it exactly as a real review would.
 *
 * Classification runs on paths alone — no repository, no `.gitattributes` — which is enough
 * for lockfiles and build output, and keeps a fixture a single file on disk.
 */
export function load(name: string): Fixture {
  const files = parseDiff(fs.readFileSync(path.join(dir, `${name}.diff`), 'utf8'));

  const inputs = new Map<string, ClassifyInput>(
    files.map((file) => [file.path, { workspace: { monorepo: false } } satisfies ClassifyInput]),
  );
  applyVerdicts(files, classifyAll(files, inputs));

  const expectation = JSON.parse(fs.readFileSync(path.join(dir, `${name}.expected.json`), 'utf8')) as {
    why: string;
    groups: Grouping;
    unordered?: [number, number][];
  };

  return {
    name,
    files,
    digest: buildDigest(files, new Map(), 60_000),
    expected: expectation.groups,
    unordered: expectation.unordered ?? [],
    why: expectation.why,
  };
}

/** Cohorts as label groups in reading order, which is the only shape the score compares. */
export function toGrouping(cohorts: readonly Cohort[], fixture: Fixture): Grouping {
  const labelOf = new Map([...fixture.digest.labels].map(([label, hunk]) => [hunk.id, label]));

  const groups: Grouping = [];
  for (const cohort of cohorts) {
    if (cohort.kind === 'scaffolding') continue;
    const labels = cohort.layers
      .flatMap((layer) => layer.hunkIds)
      .map((id) => labelOf.get(id))
      .filter((label): label is string => label !== undefined);
    if (labels.length > 0) groups.push(labels);
  }
  return groups;
}

export function heuristicGrouping(fixture: Fixture): Grouping {
  return toGrouping(heuristicCohorts(fixture.files), fixture);
}

/** Every label with the file it stands for — what a hand-written expectation is written from. */
export function labelTable(fixture: Fixture): string {
  return [...fixture.digest.labels]
    .map(([label, hunk]) => `${label.padEnd(4)} ${hunk.path}:${hunk.newStart}  ${hunk.symbol ?? ''}`)
    .join('\n');
}
