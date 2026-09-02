import type { Hunk } from '../model/types.js';

export type Anchor =
  | { kind: 'exact'; hunkId: string }
  | { kind: 'moved'; hunkId: string; score: number }
  | { kind: 'orphaned' };

/** Below this a pair is not the same hunk, however suggestive the overlap looks. */
const MOVED_THRESHOLD = 0.8;

/** A single line pair has to be at least this alike before it counts as the same line. */
const LINE_FLOOR = 0.6;

/** Past this many leftover lines the quadratic pass is skipped rather than run slowly. */
const PAIRING_CAP = 120;

/**
 * Match the hunks of a previous review against a freshly parsed one.
 *
 * This is the most dangerous code in the extension. A tick on a hunk that changed underneath
 * is how a review tool loses trust permanently, so the result distinguishes what it knows
 * from what it is guessing: `exact` is certain, `moved` is a guess and is labelled one, and
 * anything else is `orphaned` rather than quietly dropped. What the caller does with a guess
 * is the caller's decision — marks refuse them, comments accept them and say so.
 */
export function reanchor(
  previous: readonly Hunk[],
  current: readonly Hunk[],
  threshold = MOVED_THRESHOLD,
): Map<string, Anchor> {
  const byId = new Map(current.map((hunk) => [hunk.id, hunk]));
  const anchors = new Map<string, Anchor>();
  const claimed = new Set<string>();

  const unmatched: Hunk[] = [];
  for (const hunk of previous) {
    if (byId.has(hunk.id)) {
      anchors.set(hunk.id, { kind: 'exact', hunkId: hunk.id });
      claimed.add(hunk.id);
    } else {
      unmatched.push(hunk);
    }
  }

  // Score every remaining pair within the same file, then take the best pairs first, so two
  // similar hunks cannot both claim the same replacement.
  const candidates: { from: string; to: string; score: number }[] = [];
  for (const before of unmatched) {
    for (const after of current) {
      if (claimed.has(after.id)) continue;
      if (after.path !== before.path) continue;
      const score = similarity(before, after);
      if (score >= threshold) candidates.push({ from: before.id, to: after.id, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  for (const candidate of candidates) {
    if (anchors.has(candidate.from) || claimed.has(candidate.to)) continue;
    anchors.set(candidate.from, { kind: 'moved', hunkId: candidate.to, score: candidate.score });
    claimed.add(candidate.to);
  }

  for (const hunk of unmatched) {
    if (!anchors.has(hunk.id)) anchors.set(hunk.id, { kind: 'orphaned' });
  }

  return anchors;
}

/**
 * How alike two hunks are, from 0 to 1.
 *
 * Added lines are only ever compared with added lines. Letting a line and its own deletion
 * vouch for each other would score an edit and its own reversal as the same hunk.
 */
export function similarity(a: Hunk, b: Hunk): number {
  const aAdded = changed(a, '+');
  const bAdded = changed(b, '+');
  const aRemoved = changed(a, '-');
  const bRemoved = changed(b, '-');

  const addedWeight = aAdded.length + bAdded.length;
  const removedWeight = aRemoved.length + bRemoved.length;
  if (addedWeight + removedWeight === 0) return a.lines[0] === b.lines[0] ? 1 : 0;

  const added = addedWeight === 0 ? 0 : lineSimilarity(aAdded, bAdded) * addedWeight;
  const removed = removedWeight === 0 ? 0 : lineSimilarity(aRemoved, bRemoved) * removedWeight;
  return (added + removed) / (addedWeight + removedWeight);
}

/**
 * Two passes. Identical lines match first, so nothing is spent on the easy case. Whatever is
 * left is paired by how much of each line survived, which is what makes the measure usable
 * at all on small hunks: a one-line change that later gains a clause shares no whole line
 * with its predecessor, and whole-line matching alone would call it unrelated.
 */
function lineSimilarity(x: readonly string[], y: readonly string[]): number {
  if (x.length === 0 && y.length === 0) return 1;
  if (x.length === 0 || y.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const line of y) counts.set(line, (counts.get(line) ?? 0) + 1);

  let matched = 0;
  const leftX: string[] = [];
  for (const line of x) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) {
      counts.set(line, remaining - 1);
      matched += 1;
    } else {
      leftX.push(line);
    }
  }

  const leftY: string[] = [];
  for (const [line, remaining] of counts) {
    for (let i = 0; i < remaining; i += 1) leftY.push(line);
  }

  if (leftX.length > 0 && leftY.length > 0 && leftX.length <= PAIRING_CAP && leftY.length <= PAIRING_CAP) {
    const taken = new Set<number>();
    for (const line of leftX) {
      let bestScore = 0;
      let bestAt = -1;
      for (let i = 0; i < leftY.length; i += 1) {
        if (taken.has(i)) continue;
        const score = lineOverlap(line, leftY[i]!);
        if (score > bestScore) {
          bestScore = score;
          bestAt = i;
        }
      }
      if (bestAt !== -1 && bestScore >= LINE_FLOOR) {
        taken.add(bestAt);
        matched += bestScore;
      }
    }
  }

  return (2 * matched) / (x.length + y.length);
}

/** How much of two lines is shared at their ends — cheap, and right for an edited line. */
export function lineOverlap(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;

  let prefix = 0;
  const shortest = Math.min(a.length, b.length);
  while (prefix < shortest && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (suffix < shortest - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;

  return (prefix + suffix) / longest;
}

function changed(hunk: Hunk, sign: '+' | '-'): string[] {
  const out: string[] = [];
  for (const line of hunk.lines) {
    if (line[0] === sign) out.push(line.slice(1).trim());
  }
  return out;
}
