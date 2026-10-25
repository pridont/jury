import { list, type StoredReview } from '../state/store.js';
import type { Repo } from '../git/repo.js';
import type { ReviewSpec } from '../model/types.js';

/** Past this, the map crowds out the change it is context for. */
const MAX_CHARS = 4000;

type Tour = Extract<ReviewSpec, { kind: 'trail' }>;

/**
 * How the codebase is organised, from a tour already taken of it: its summary, its areas and
 * the files each covers, and its diagram. Empty when no saved tour covers the change.
 *
 * Nothing is asked of the model here. A tour is saved like any review, so the map is the
 * best saved tour for these paths: the one covering most of them, the newest on a tie. It
 * may be older than the code; the grouping prompt is told so.
 */
export async function codebaseMap(repo: Repo, paths: readonly string[]): Promise<string> {
  return mapFrom(await list(repo).catch(() => []), paths);
}

/** `reviews` newest first, as `list` returns them. */
export function mapFrom(reviews: readonly StoredReview[], paths: readonly string[]): string {
  let best: Tour | null = null;
  let covered = 0;
  for (const { spec } of reviews) {
    if (spec.kind !== 'trail' || !spec.steps.some((step) => step.area)) continue;
    // A tour of one folder is titled after it, `Tour of src/`; of the whole repository, not.
    const folder = /^Tour of (.+\/)$/.exec(spec.question)?.[1] ?? '';
    const count = paths.filter((p) => p.startsWith(folder)).length;
    if (count > covered) [best, covered] = [spec, count];
  }
  return best ? render(best) : '';
}

function render(tour: Tour): string {
  const areas = new Map<string, Set<string>>();
  for (const step of tour.steps) {
    const files = areas.get(step.area ?? step.title) ?? new Set();
    for (const span of step.spans) files.add(span.path);
    areas.set(step.area ?? step.title, files);
  }

  const parts = [
    `${tour.question}: ${tour.summary}`,
    'Areas, and the files read for each:\n' +
      [...areas].map(([area, files]) => `- ${area}: ${[...files].join(', ')}`).join('\n'),
  ];
  if (tour.diagram) parts.push(`How they fit together:\n${tour.diagram}`);

  const text = parts.join('\n\n');
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n… (cut short)`;
}
