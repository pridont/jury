import { createHash } from 'node:crypto';

/**
 * Hunk identity is content-based, never positional.
 *
 * The body is the changed lines only — no `@@` header, no context lines, no trailing
 * whitespace — so a hunk keeps its identity when the code around it moves, and loses it the
 * moment its own content changes. That is what makes a review mark survive a rebase and
 * correctly reset on an amend.
 */
export function hunkBody(lines: readonly string[]): string {
  const changed: string[] = [];
  for (const line of lines) {
    const first = line[0];
    if (first === '+' || first === '-') {
      changed.push(first + line.slice(1).replace(/\s+$/, ''));
    }
  }
  return changed.join('\n');
}

export function hunkId(path: string, body: string): string {
  return createHash('sha256').update(`${path}\0${body}`).digest('hex').slice(0, 16);
}

/**
 * Two identical hunks in one file hash the same. Disambiguate by occurrence so each stays
 * independently reviewable, rather than one silently standing in for the other.
 */
export function disambiguate(ids: string[]): string[] {
  const seen = new Map<string, number>();
  return ids.map((id) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}:${n}`;
  });
}
