import type { FileChange } from '../git/parse.js';
import { Cache } from './cache.js';
import { askForJson, parse, type Accepted } from './json.js';
import { askContext } from './prompts/ask.js';
import { questionsPrompt } from './prompts/questions.js';
import { inputBudget, ProviderError, type PassDeps, type Usage } from './provider.js';
import { buildOrder } from '../model/order.js';
import { questionsOf, type QuestionsOutput } from '../model/questions.js';
import type { Cohort, Question } from '../model/types.js';

export type QuestionsResult =
  | { ok: true; questions: Map<Cohort, Question[]>; usage: Usage | null; cached: boolean }
  | { ok: false; reason: string };

/** Nothing to ask about generator output, or about what the model could not place. */
function worthAsking(cohort: Cohort): boolean {
  return cohort.kind !== 'scaffolding' && cohort.kind !== 'unclassified';
}

/**
 * Pass 3 — questions to read with, after grouping.
 *
 * One call for every cohort, not one each: the cohorts share the input budget, and a review
 * of eight cohorts costs one request rather than eight. Checked and cached like grouping,
 * and as optional as summaries: if it fails, the review is exactly what it was.
 */
export async function askQuestions(
  deps: PassDeps,
  cohorts: readonly Cohort[],
  files: readonly FileChange[],
): Promise<QuestionsResult> {
  const asked = cohorts.filter(worthAsking);
  if (asked.length === 0) return { ok: false, reason: 'nothing to ask about' };

  const labels = new Map(asked.map((cohort, index) => [`c${index + 1}`, cohort]));
  const input = describeCohorts(labels, files, inputBudget(deps.provider) - questionsPrompt.system.length);

  const model = deps.provider.capabilities().models.smart ?? 'smart';
  const key = Cache.key({ promptVersion: questionsPrompt.version, model, input });

  const hit = await deps.cache.get(key);
  if (hit !== null) {
    const fromCache = accept(hit, labels);
    if (fromCache.ok) return { ok: true, questions: fromCache.value.questions, usage: null, cached: true };
    deps.log(`  cached questions rejected (${fromCache.error}); asking again`);
  }

  try {
    return await deps.queue.run(deps.owner, async (signal) => {
      const { result, usage } = await askForJson(
        deps.provider,
        { tier: 'smart', system: questionsPrompt.system, input },
        signal,
        (answer) => accept(answer, labels),
        (error) => deps.log(`  questions answer did not parse (${error}); asking for it back, fixed`),
      );
      if (!result.ok) {
        deps.log(`  questions declined: ${result.error}`);
        return { ok: false, reason: result.error };
      }

      await deps.cache.set(key, result.value.text);
      const count = [...result.value.questions.values()].reduce((n, list) => n + list.length, 0);
      deps.log(
        `  questions: ${count} on ${result.value.questions.size} cohorts, ${usage.inputTokens} in, ` +
          `${usage.outputTokens} out, ${usage.durationMs}ms, $${usage.costUsd.toFixed(4)}`,
      );
      return { ok: true, questions: result.value.questions, usage, cached: false };
    });
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'cancelled') return { ok: false, reason: 'cancelled' };
    if (error instanceof Error && error.name === 'AbortError') return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Every cohort under its label, sharing `budget` equally; past its share a hunk is named, not shown. */
export function describeCohorts(labels: ReadonlyMap<string, Cohort>, files: readonly FileChange[], budget: number): string {
  const share = Math.floor(budget / Math.max(labels.size, 1));
  return [...labels]
    .map(([label, cohort]) => {
      const order = buildOrder([cohort], files);
      const first = order[0];
      return first ? `# Cohort ${label}\n${askContext(first, 'cohort', order, share, false)}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function accept(
  text: string,
  labels: ReadonlyMap<string, Cohort>,
): Accepted<{ questions: Map<Cohort, Question[]>; text: string }> {
  const parsed = parse<QuestionsOutput>(text, questionsPrompt.shape);
  if (!parsed.ok) return { ok: false, error: parsed.error, repairable: true };

  const found = questionsOf(parsed.value, labels);
  // A schema-valid answer with nothing usable in it is declined, so it is never cached.
  if (found.size === 0) return { ok: false, error: 'no cohort had a usable question', repairable: false };

  const questions = new Map([...found].map(([label, list]) => [labels.get(label)!, list]));
  return { ok: true, value: { questions, text } };
}
