import type { FileChange } from '../git/parse.js';
import { disambiguate, hunkId } from '../git/identity.js';
import type { Cohort, Hunk, TrailStep } from './types.js';

/**
 * A trail as a review: every span a hunk of unchanged lines, every step a cohort.
 *
 * A span is a hunk with no `+` or `-` in it, so marking, notes, stepping and the tree work
 * on it exactly as on a change. Its id hashes the lines it covers, the way a change's hashes
 * what changed: edit the code and the mark goes.
 *
 * `read` gives a file's lines, or null when there is no such file. Spans outside the file
 * are clamped to it, and a span with nothing left, a file that is not there, and a step with
 * no spans are dropped: the model's line numbers are a claim, the file is the fact.
 */
export function buildTrail(
  steps: readonly TrailStep[],
  read: (path: string) => string[] | null,
): { files: FileChange[]; cohorts: Cohort[] } {
  const byPath = new Map<string, Hunk[]>();
  const placed: Hunk[][] = steps.map(() => []);

  steps.forEach((step, index) => {
    for (const span of step.spans) {
      const lines = read(span.path);
      if (!lines) continue;
      const start = Math.max(1, Math.floor(span.start));
      const end = Math.min(lines.length, Math.floor(span.end));
      if (end < start) continue;

      const count = end - start + 1;
      const hunk: Hunk = {
        id: '',
        path: span.path,
        oldStart: start,
        oldCount: count,
        newStart: start,
        newCount: count,
        lines: lines.slice(start - 1, end).map((line) => ` ${line}`),
        stats: { added: 0, removed: 0 },
        kind: 'text',
      };
      // A key line clamped out of its span points at nothing the reader is shown.
      const focus = span.focus === undefined ? NaN : Math.floor(span.focus);
      if (focus >= start && focus <= end) hunk.focus = focus;
      placed[index]!.push(hunk);
      byPath.set(span.path, [...(byPath.get(span.path) ?? []), hunk]);
    }
  });

  const files: FileChange[] = [...byPath].map(([path, hunks]) => {
    hunks.sort((a, b) => a.newStart - b.newStart);
    const ids = disambiguate(hunks.map((hunk) => hunkId(path, hunk.lines.join('\n'))));
    hunks.forEach((hunk, i) => (hunk.id = ids[i]!));
    return { path, status: 'unchanged', binary: false, hunks, stats: { added: 0, removed: 0 } };
  });

  // A step is a cohort of its own, unless it shares an area with the step before it: then
  // it is the next layer of that area's cohort, as a tour reads one part of the code at a time.
  const cohorts: Cohort[] = [];
  let area: string | undefined;
  steps.forEach((step, index) => {
    const hunks = placed[index]!;
    if (hunks.length === 0) return;
    const id = `t${index + 1}`;
    const layer = {
      id: `${id}l1`,
      title: step.title,
      summary: step.summary,
      hunkIds: hunks.map((hunk) => hunk.id),
      paths: [...new Set(hunks.map((hunk) => hunk.path))],
    };

    const last = cohorts.at(-1);
    if (last && step.area && step.area === area) {
      last.layers.push(layer);
      last.summary = '';
      return;
    }
    area = step.area;
    cohorts.push({
      id,
      title: step.area || step.title,
      // A cohort of one layer is drawn as that layer, so it speaks for it. An area of
      // several says nothing a stop does not say better.
      summary: step.summary,
      kind: 'change',
      risk: 'low',
      origin: 'ai',
      layers: [layer],
    });
  });

  // An area with one stop is drawn as one row: it carries the stop's name as well as its own.
  for (const cohort of cohorts) {
    const only = cohort.layers.length === 1 ? cohort.layers[0]! : undefined;
    if (only && cohort.title !== only.title) cohort.title = `${cohort.title}: ${only.title}`;
  }

  return { files, cohorts };
}
