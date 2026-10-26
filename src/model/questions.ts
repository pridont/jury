import type { Cohort, Question } from './types.js';

/** What pass 3 is contracted to return. Nothing here is trusted until `questionsOf` has run. */
export type QuestionsOutput = { cohorts?: unknown };

/** More than this per cohort and they stop being read; the prompt asks for two or three. */
export const MAX_QUESTIONS = 3;

/**
 * A finding dressed as a question. The README rules out review findings, so a question that
 * asks for a verdict or proposes a change is dropped rather than shown.
 */
export const VERDICT =
  /\b(bug|bugs|buggy|mistake|typo|wrong|incorrect|correct|safe|unsafe|a good idea|intended|intentional)\b|^\s*(should|shouldn't|could|couldn't|would|wouldn't|why not|have you|did you|consider)\b/i;

/**
 * Turn model output into questions per cohort, keyed by the label the cohort was sent under.
 *
 * Each kept question has a perspective, ends in a question mark, asks for no verdict, and
 * comes from a perspective no earlier question on that cohort took: perspectives that overlap
 * lose what made them worth asking. A cohort label leaked into the text is replaced by the
 * cohort's title, since the reader never saw the label.
 */
export function questionsOf(
  output: QuestionsOutput,
  cohorts: ReadonlyMap<string, Cohort>,
): Map<string, Question[]> {
  const found = new Map<string, Question[]>();
  const raw = Array.isArray(output.cohorts) ? output.cohorts : [];

  for (const candidate of raw) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    const label = text(record['id']);
    if (!cohorts.has(label) || found.has(label)) continue;

    const kept: Question[] = [];
    const seen = new Set<string>();
    for (const entry of Array.isArray(record['questions']) ? record['questions'] : []) {
      if (typeof entry !== 'object' || entry === null) continue;
      const perspective = text((entry as Record<string, unknown>)['perspective']);
      const question = unlabelCohorts(text((entry as Record<string, unknown>)['question']), cohorts);
      if (!perspective || !question.endsWith('?') || VERDICT.test(question)) continue;
      if (seen.has(perspective.toLowerCase())) continue;
      seen.add(perspective.toLowerCase());
      kept.push({ perspective, question });
      if (kept.length === MAX_QUESTIONS) break;
    }
    if (kept.length > 0) found.set(label, kept);
  }
  return found;
}

function unlabelCohorts(value: string, cohorts: ReadonlyMap<string, Cohort>): string {
  return value.replace(/\bc(\d+)\b/g, (match) => {
    const cohort = cohorts.get(match);
    return cohort ? `"${cohort.title}"` : match;
  });
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
