/**
 * Scoring a clustering against a hand-written expectation.
 *
 * Two numbers, both over pairs of hunks, because a stack is not a sequence to diff against:
 *
 * - **grouping** — for every pair, do the expectation and the answer agree about whether
 *   those two hunks belong together?
 * - **order** — for every pair the expectation puts in *different* groups, does the answer
 *   read them in the same order?
 *
 * Both are reported against the heuristic, which is the number clustering has to beat to be
 * worth anything at all.
 */
export type Grouping = string[][];

export type Score = { grouping: number; order: number; pairs: number };

/**
 * Pairs of expected groups whose relative order carries no meaning.
 *
 * Two pieces of work that touch nothing in common can be read in either order, and scoring a
 * coin flip as if it were a mistake makes the order figure noise. Excluding those pairs is
 * what lets the number mean "did it get the dependencies right".
 */
export type Unordered = readonly (readonly [number, number])[];

export function score(expected: Grouping, actual: Grouping, unordered: Unordered = []): Score {
  const labels = [...new Set(expected.flat())];
  const expectedGroup = indexOf(expected);
  const actualGroup = indexOf(actual);
  const actualRank = rankOf(actual);
  const expectedRank = rankOf(expected);

  let groupingAgree = 0;
  let groupingPairs = 0;
  let orderAgree = 0;
  let orderPairs = 0;

  const arbitrary = new Set(unordered.map(([a, b]) => (a < b ? `${a}:${b}` : `${b}:${a}`)));

  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i]!;
      const b = labels[j]!;

      const together = expectedGroup.get(a) === expectedGroup.get(b);
      // A label the answer never placed counts against it rather than being skipped.
      const claimedTogether = actualGroup.has(a) && actualGroup.has(b) && actualGroup.get(a) === actualGroup.get(b);
      groupingPairs += 1;
      if (together === claimedTogether) groupingAgree += 1;

      if (together) continue;

      const groupA = expectedGroup.get(a)!;
      const groupB = expectedGroup.get(b)!;
      if (arbitrary.has(groupA < groupB ? `${groupA}:${groupB}` : `${groupB}:${groupA}`)) continue;

      orderPairs += 1;
      const expectedFirst = (expectedRank.get(a) ?? 0) < (expectedRank.get(b) ?? 0);
      const actualFirst = (actualRank.get(a) ?? Infinity) < (actualRank.get(b) ?? Infinity);
      if (expectedFirst === actualFirst) orderAgree += 1;
    }
  }

  return {
    grouping: groupingPairs === 0 ? 1 : groupingAgree / groupingPairs,
    order: orderPairs === 0 ? 1 : orderAgree / orderPairs,
    pairs: groupingPairs,
  };
}

function indexOf(grouping: Grouping): Map<string, number> {
  const out = new Map<string, number>();
  grouping.forEach((group, index) => {
    for (const label of group) out.set(label, index);
  });
  return out;
}

/** Reading position of each label, flattened across groups. */
function rankOf(grouping: Grouping): Map<string, number> {
  const out = new Map<string, number>();
  let rank = 0;
  for (const group of grouping) {
    for (const label of group) out.set(label, rank++);
  }
  return out;
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
