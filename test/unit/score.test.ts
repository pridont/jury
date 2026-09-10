import { describe, expect, it } from 'vitest';
import { score } from '../eval/score.js';

describe('score', () => {
  const expected = [
    ['h1', 'h2'],
    ['h3'],
    ['h4', 'h5'],
  ];

  it('is perfect for the expected grouping itself', () => {
    const result = score(expected, expected);
    expect(result.grouping).toBe(1);
    expect(result.order).toBe(1);
  });

  it('scores a grouping that is right but read backwards', () => {
    const result = score(expected, [...expected].reverse());
    expect(result.grouping).toBe(1);
    expect(result.order).toBe(0);
  });

  it('punishes putting everything in one group', () => {
    const result = score(expected, [expected.flat()]);
    expect(result.grouping).toBeLessThan(0.6);
  });

  it('punishes splitting everything apart', () => {
    const result = score(expected, expected.flat().map((label) => [label]));
    expect(result.grouping).toBeLessThan(1);
    expect(result.grouping).toBeGreaterThan(0.6);
  });

  it('counts a hunk the answer never placed against it', () => {
    const partial = [['h1', 'h2'], ['h3']];
    expect(score(expected, partial).grouping).toBeLessThan(1);
  });

  it('does not score the order of two groups whose order is arbitrary', () => {
    const two = [['h1'], ['h2']];
    const swapped = [['h2'], ['h1']];

    expect(score(two, swapped).order).toBe(0);
    // Marked arbitrary, that pair is not evidence either way, and nothing else is left.
    expect(score(two, swapped, [[0, 1]]).order).toBe(1);
  });

  it('still scores the pairs that do mean something', () => {
    const three = [['h1'], ['h2'], ['h3']];
    // h1 and h3 may be read in either order; h2 must still come after h1.
    const wrong = [['h2'], ['h1'], ['h3']];
    expect(score(three, wrong, [[0, 2]]).order).toBeLessThan(1);
  });

  it('ignores order within a group, which is not what order means here', () => {
    const shuffled = [['h2', 'h1'], ['h3'], ['h5', 'h4']];
    expect(score(expected, shuffled).order).toBe(1);
  });
});
