import type { TrailStep } from '../model/types.js';
import { parse } from './json.js';
import { trailPrompt } from './prompts/trail.js';
import type { Provider, Usage } from './provider.js';

export type Trail = { summary: string; steps: TrailStep[] };

/** More than this is not a trail anyone follows to the end. */
const MAX_STEPS = 12;
const MAX_SPANS = 6;

/**
 * Ask for a trail through the repository that answers `question`.
 *
 * It needs the repository's tools: a trail is line numbers, and line numbers nobody read are
 * made up. `onTool` hears each tool call as it is made, so the wait has a visible reason.
 */
export async function askTrail(
  provider: Provider,
  root: string,
  question: string,
  signal: AbortSignal,
  onTool: (label: string) => void,
): Promise<{ ok: true; trail: Trail; usage: Usage } | { ok: false; reason: string }> {
  const answer = await provider.stream(
    {
      tier: 'smart',
      system: trailPrompt.system,
      input: `Question: ${question}`,
      // Read-only by design, as for every question.
      tools: ['readFile', 'search', 'listFiles'],
      cwd: root,
    },
    signal,
    (chunk) => {
      if (chunk.kind === 'tool') onTool(chunk.label);
    },
  );

  const parsed = parse<{ summary: string; steps: unknown[] }>(answer.text, trailPrompt.shape);
  if (!parsed.ok) return { ok: false, reason: `the answer was not a trail (${parsed.error})` };

  const steps = parsed.value.steps.flatMap(step).slice(0, MAX_STEPS);
  if (steps.length === 0) return { ok: false, reason: 'the answer had no steps with code in them' };
  return { ok: true, trail: { summary: parsed.value.summary, steps }, usage: answer.usage };
}

/** One step as the model wrote it, or nothing when it is not one. */
function step(value: unknown): TrailStep[] {
  if (typeof value !== 'object' || value === null) return [];
  const { title, summary, spans } = value as Record<string, unknown>;
  if (typeof title !== 'string' || !Array.isArray(spans)) return [];

  const kept = spans
    .filter(
      (span): span is { path: string; start: number; end: number } =>
        typeof span === 'object' &&
        span !== null &&
        typeof span.path === 'string' &&
        Number.isFinite(span.start) &&
        Number.isFinite(span.end),
    )
    .map(({ path, start, end }) => ({ path: path.replace(/^\.\//, ''), start, end }))
    .slice(0, MAX_SPANS);
  return kept.length > 0 ? [{ title, summary: typeof summary === 'string' ? summary : '', spans: kept }] : [];
}
