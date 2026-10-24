import type { TrailStep } from '../model/types.js';
import { diagramOf } from '../model/merge.js';
import { parse } from './json.js';
import { tourPrompt } from './prompts/tour.js';
import { trailPrompt } from './prompts/trail.js';
import type { Provider, Usage } from './provider.js';

export type Trail = { summary: string; steps: TrailStep[]; diagram?: string };

/**
 * A trail answers a question; a tour walks a whole codebase, or a folder of it. More steps
 * than these is not something anyone follows to the end.
 */
const KINDS = {
  trail: { prompt: trailPrompt, label: 'Question', maxSteps: 12 },
  tour: { prompt: tourPrompt, label: 'Tour', maxSteps: 35 },
};
const MAX_SPANS = 6;
/** A span is read in one look. The prompt asks for this, and models do not always listen. */
const MAX_SPAN_LINES = 80;

/**
 * Ask for a trail through the repository that answers `question`, or with `tour`, for a
 * tour of what `question` names: the repository, or one folder of it.
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
  kind: keyof typeof KINDS = 'trail',
): Promise<{ ok: true; trail: Trail; usage: Usage } | { ok: false; reason: string }> {
  const answer = await provider.stream(
    {
      tier: 'smart',
      system: KINDS[kind].prompt.system,
      input: `${KINDS[kind].label}: ${question}`,
      // Read-only by design, as for every question.
      tools: ['readFile', 'search', 'listFiles'],
      cwd: root,
    },
    signal,
    (chunk) => {
      if (chunk.kind === 'tool') onTool(chunk.label);
    },
  );

  const parsed = parse<{ summary: string; steps: unknown[]; diagram?: unknown }>(answer.text, KINDS[kind].prompt.shape);
  if (!parsed.ok) return { ok: false, reason: `the answer was not a trail (${parsed.error})` };

  const steps = parsed.value.steps.flatMap(step).slice(0, KINDS[kind].maxSteps);
  if (steps.length === 0) return { ok: false, reason: 'the answer had no steps with code in them' };
  const diagram = diagramOf(parsed.value.diagram);
  return {
    ok: true,
    trail: { summary: parsed.value.summary, steps, ...(diagram ? { diagram } : {}) },
    usage: answer.usage,
  };
}

/** One step as the model wrote it, or nothing when it is not one. */
function step(value: unknown): TrailStep[] {
  if (typeof value !== 'object' || value === null) return [];
  const { title, summary, spans, area } = value as Record<string, unknown>;
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
    .map(({ path, start, end }) => ({ path: path.replace(/^\.\//, ''), start, end: Math.min(end, start + MAX_SPAN_LINES - 1) }))
    .slice(0, MAX_SPANS);
  if (kept.length === 0) return [];
  return [
    {
      title,
      summary: typeof summary === 'string' ? summary : '',
      spans: kept,
      ...(typeof area === 'string' && area.trim() ? { area: area.trim() } : {}),
    },
  ];
}
