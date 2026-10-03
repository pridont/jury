import type { FileChange } from '../git/parse.js';
import { Cache } from './cache.js';
import { askForJson, parse, type Accepted } from './json.js';
import { clusterPrompt } from './prompts/cluster.js';
import { ProviderError, type PassDeps, type Usage } from './provider.js';
import { buildDigest, type Digest } from './digest.js';
import { merge, type ClusterOutput, type Merged } from '../model/merge.js';

export type ClusterResult =
  | { ok: true; merged: Merged; usage: Usage | null; cached: boolean }
  | { ok: false; reason: string };

/**
 * Pass 2 — the reordering the extension exists for.
 *
 * One call decides the whole product, so the answer is checked before it is believed:
 * `merge` has to turn it into a complete partition of the hunk set, and a clustering that
 * organised nothing is declined outright. A declined answer is never written to the cache,
 * because a schema-valid non-answer cached is a known-bad result replayed on every open.
 */
export async function clusterChange(
  deps: PassDeps,
  files: readonly FileChange[],
  summaries: ReadonlyMap<string, string>,
): Promise<ClusterResult> {
  const budget = Math.min(deps.provider.capabilities().maxInputChars, 60_000);
  const digest = buildDigest(files, summaries, budget);

  if (digest.labels.size === 0) return { ok: false, reason: 'nothing to organise' };
  if (digest.labels.size < 3) return { ok: false, reason: 'too few hunks to be worth organising' };

  const model = deps.provider.capabilities().models.smart ?? 'smart';
  const key = Cache.key({ promptVersion: clusterPrompt.version, model, input: digest.text });

  const hit = await deps.cache.get(key);
  if (hit !== null) {
    const fromCache = accept(hit, digest);
    // A cached answer is judged by the same standard when it is read back, so an entry
    // stored before a caller learned to reject it is forgotten rather than served forever.
    if (fromCache.ok) return { ok: true, merged: fromCache.value.merged, usage: null, cached: true };
    deps.log(`  cached clustering rejected (${fromCache.error}); asking again`);
  }

  try {
    return await deps.queue.run(deps.owner, async (signal) => {
      const { result, usage } = await askForJson(
        deps.provider,
        { tier: 'smart', system: clusterPrompt.system, input: digest.text },
        signal,
        (answer) => accept(answer, digest),
        (error) => deps.log(`  clustering answer did not parse (${error}); asking for it back, fixed`),
      );

      if (!result.ok) {
        deps.log(`  clustering declined: ${result.error}`);
        return { ok: false, reason: result.error };
      }

      const { merged, text } = result.value;
      await deps.cache.set(key, text);
      deps.log(
        `  clustering: ${merged.cohorts.length} cohorts, ${usage.inputTokens} in, ` +
          `${usage.outputTokens} out, ${usage.durationMs}ms, $${usage.costUsd.toFixed(4)}`,
      );
      return { ok: true, merged, usage, cached: false };
    });
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'cancelled') return { ok: false, reason: 'cancelled' };
    if (error instanceof Error && error.name === 'AbortError') return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The text rides along with the result, since it is what gets cached. */
function accept(text: string, digest: Digest): Accepted<{ merged: Merged; text: string }> {
  const parsed = parse<ClusterOutput>(text, clusterPrompt.shape);
  if (!parsed.ok) return { ok: false, error: parsed.error, repairable: true };

  const result = merge(parsed.value, digest.labels, digest.scaffolding);
  if (!result.ok) return { ok: false, error: result.reason, repairable: false };

  return { ok: true, value: { merged: result.merged, text } };
}
