/** Past this many inserted or deleted lines two texts are not worth lining up. */
const MAX_EDITS = 1000;

/**
 * For each line of `a`, the index of the same line in `b`, or -1 when `b` does not have it.
 *
 * The pairing is a longest common subsequence (Myers), so it only ever moves forward: a
 * repeated line — a blank, a closing brace — pairs with its counterpart in the same stretch
 * of code, not with the first one that happens to look alike. Null when the two texts are
 * too far apart to pair at all, which is cheaper to say than to compute.
 */
export function matchLines(a: readonly string[], b: readonly string[], maxEdits = MAX_EDITS): Int32Array | null {
  const map = new Int32Array(a.length).fill(-1);

  // Most pairs differ in one region; the shared head and tail need no search.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    map[start] = start;
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    map[endA] = endB;
  }

  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return map;

  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // `trace[d]` is the frontier as it stood before step d, kept only for diagonals d can reach.
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        backtrack(trace, d, n, m, (i, j) => (map[start + i] = start + j));
        return map;
      }
    }
  }
  return null;
}

/** Walk the snakes back from the end, reporting every pair of equal lines on the way. */
function backtrack(trace: Int32Array[], edits: number, n: number, m: number, pair: (i: number, j: number) => void) {
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d--) {
    const frontier = trace[d]!;
    const at = (k: number) => frontier[k + d + 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const snakeX = down ? previousX : previousX + 1;
    while (x > snakeX) {
      x--;
      y--;
      pair(x, y);
    }
    x = previousX;
    y = previousX - previousK;
  }
  while (x > 0) {
    x--;
    y--;
    pair(x, y);
  }
}
