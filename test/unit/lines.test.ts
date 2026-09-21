import { describe, expect, it } from 'vitest';
import { matchLines } from '../../src/model/lines.js';

const pairs = (a: string[], b: string[]) => {
  const map = matchLines(a, b);
  return map ? [...map] : null;
};

describe('matchLines', () => {
  it('pairs every line of identical texts with itself', () => {
    expect(pairs(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([0, 1, 2]);
  });

  it('shifts the lines after an insertion', () => {
    expect(pairs(['a', 'b', 'c'], ['a', 'x', 'y', 'b', 'c'])).toEqual([0, 3, 4]);
  });

  it('leaves a removed line unpaired', () => {
    expect(pairs(['a', 'gone', 'b'], ['a', 'b'])).toEqual([0, -1, 1]);
  });

  it('leaves a changed line unpaired and keeps its neighbours', () => {
    expect(pairs(['import a', 'x = old()', 'use(x)'], ['import a', 'import b', 'x = new()', 'use(x)'])).toEqual([
      0, -1, 3,
    ]);
  });

  it('pairs repeated lines in order rather than with the first lookalike', () => {
    const a = ['f() {', '}', '', 'g() {', '}'];
    const b = ['f() {', '}', '', 'h() {', '}', '', 'g() {', '}'];
    // The last brace belongs to g, not to the h that was inserted before it.
    expect(pairs(a, b)).toEqual([0, 1, 2, 6, 7]);
  });

  it('handles changes in several separate places', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7'];
    const b = ['1', 'x', '3', '4', '5', '6', 'y', '7', 'z'];
    expect(pairs(a, b)).toEqual([0, -1, 2, 3, 4, 5, 7]);
  });

  it('handles empty sides', () => {
    expect(pairs([], ['a'])).toEqual([]);
    expect(pairs(['a'], [])).toEqual([-1]);
  });

  it('gives up on texts too far apart to line up', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(matchLines(a, b, 20)).toBeNull();
    expect(matchLines(a, b, 100)).not.toBeNull();
  });

  it('agrees with a brute-force longest common subsequence', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const text = (length: number) => Array.from({ length }, () => 'abcd'[Math.floor(random() * 4)]!);

    for (let round = 0; round < 200; round++) {
      const a = text(Math.floor(random() * 12));
      const b = text(Math.floor(random() * 12));
      const map = matchLines(a, b)!;

      let last = -1;
      let paired = 0;
      for (let i = 0; i < a.length; i++) {
        if (map[i] === -1) continue;
        expect(map[i]).toBeGreaterThan(last);
        expect(b[map[i]!]).toBe(a[i]);
        last = map[i]!;
        paired++;
      }
      expect(paired).toBe(lcsLength(a, b));
    }
  });
});

function lcsLength(a: string[], b: string[]): number {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i]![j] = a[i - 1] === b[j - 1] ? table[i - 1]![j - 1]! + 1 : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
    }
  }
  return table[a.length]![b.length]!;
}
