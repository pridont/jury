import type { FileChange } from '../git/parse.js';
import type { Cohort, Hunk, Layer } from './types.js';

export type Entry = {
  cohortIndex: number;
  layerIndex: number;
  cohort: Cohort;
  layer: Layer;
  file: FileChange;
  hunk: Hunk;
  scaffolding: boolean;
};

/**
 * The reading order, flattened.
 *
 * One list across every cohort, layer and file is what lets a single key walk an entire
 * review: file boundaries stop being something the reviewer has to think about.
 */
export function buildOrder(cohorts: readonly Cohort[], files: readonly FileChange[]): Entry[] {
  const byHunk = new Map<string, { file: FileChange; hunk: Hunk }>();
  for (const file of files) {
    for (const hunk of file.hunks) byHunk.set(hunk.id, { file, hunk });
  }

  const order: Entry[] = [];
  cohorts.forEach((cohort, cohortIndex) => {
    cohort.layers.forEach((layer, layerIndex) => {
      for (const id of layer.hunkIds) {
        const found = byHunk.get(id);
        if (!found) continue;
        order.push({
          cohortIndex,
          layerIndex,
          cohort,
          layer,
          file: found.file,
          hunk: found.hunk,
          scaffolding: found.hunk.scaffolding !== undefined,
        });
      }
    });
  });
  return order;
}

/**
 * The next position in the reading order, skipping scaffolding unless already inside it.
 *
 * `matches` narrows the walk to the hunks worth stopping at — the unreviewed ones, say, or
 * the ones a refresh brought in — so every kind of "next" is this one walk with a filter,
 * and none of them can disagree about scaffolding or about where the ends are.
 */
export function step(
  order: readonly Entry[],
  from: number,
  direction: 1 | -1,
  matches: (entry: Entry) => boolean = () => true,
): number {
  const insideScaffolding = order[from]?.scaffolding ?? false;
  for (let index = from + direction; index >= 0 && index < order.length; index += direction) {
    const entry = order[index]!;
    if (entry.scaffolding && !insideScaffolding) continue;
    if (!matches(entry)) continue;
    return index;
  }
  // Stop at the ends rather than wrapping: silently starting over reads as a bug.
  return from;
}

/**
 * How much of `entries` a person is expected to read, and how much of that they have.
 * Scaffolding is not counted: it is out of the reading order, so it is out of the score too.
 */
export function progress(
  entries: readonly Entry[],
  isMarked: (hunkId: string) => boolean,
): { reviewed: number; total: number } {
  const read = entries.filter((entry) => !entry.scaffolding);
  return { reviewed: read.filter((entry) => isMarked(entry.hunk.id)).length, total: read.length };
}

/** The next position that belongs to a different layer than the one at `from`. */
export function stepLayer(order: readonly Entry[], from: number, direction: 1 | -1): number {
  const current = order[from];
  if (!current) return from;
  for (let index = from + direction; index >= 0 && index < order.length; index += direction) {
    const entry = order[index]!;
    if (entry.cohortIndex !== current.cohortIndex || entry.layerIndex !== current.layerIndex) return index;
  }
  return from;
}

/** Where a layer should open: its first unread hunk, or its first hunk when all are read. */
export function layerEntry(
  order: readonly Entry[],
  cohortIndex: number,
  layerIndex: number,
  isMarked: (hunkId: string) => boolean,
): number {
  let first = -1;
  for (let index = 0; index < order.length; index += 1) {
    const entry = order[index]!;
    if (entry.cohortIndex !== cohortIndex || entry.layerIndex !== layerIndex) continue;
    if (first === -1) first = index;
    if (!isMarked(entry.hunk.id)) return index;
  }
  return first;
}
