import type { FileChange } from '../git/parse.js';
import { Cache } from './cache.js';
import { askForJson, parse, type Accepted } from './json.js';
import { summaryPrompt } from './prompts/summary.js';
import { ProviderError, type PassDeps, type Usage } from './provider.js';

/** Past this, a file is described by its shape rather than sent in full. */
const MAX_INPUT_CHARS = 12_000;

export type SummaryEvent =
  | { kind: 'summary'; path: string; summary: string; cached: boolean; usage?: Usage }
  | { kind: 'failed'; path: string; reason: string };

/**
 * Ask for a sentence about each file, in parallel, and hand each one back as it lands.
 *
 * Nothing here is allowed to matter: a file whose summary fails keeps the description the
 * heuristic gave it, and the review is a little less useful rather than broken. Scaffolding
 * is not summarised at all — spending tokens describing a lockfile is the thing this feature
 * exists to avoid.
 */
export async function summariseFiles(
  deps: PassDeps,
  files: readonly FileChange[],
  onEvent: (event: SummaryEvent) => void,
): Promise<{ summarised: number; cached: number; failed: number; costUsd: number }> {
  const worth = files.filter(isWorthSummarising);
  const tally = { summarised: 0, cached: 0, failed: 0, costUsd: 0 };

  await Promise.all(
    worth.map(async (file) => {
      const input = describeFile(file);
      const key = Cache.key({
        promptVersion: summaryPrompt.version,
        model: deps.provider.capabilities().models.fast ?? 'fast',
        input,
      });

      const hit = await deps.cache.get(key);
      if (hit !== null) {
        tally.cached += 1;
        onEvent({ kind: 'summary', path: file.path, summary: hit, cached: true });
        return;
      }

      try {
        const summary = await deps.queue.run(deps.owner, async (signal) => {
          const { result, usage } = await askForJson(
            deps.provider,
            { tier: 'fast', system: summaryPrompt.system, input },
            signal,
            acceptSummary,
          );
          if (!result.ok) throw new ProviderError('failed', result.error);

          // Cached only now, after the caller has accepted it.
          await deps.cache.set(key, result.value);
          return { text: result.value, usage };
        });

        tally.summarised += 1;
        tally.costUsd += summary.usage.costUsd;
        deps.log(
          `  ${file.path}: ${summary.usage.inputTokens} in, ${summary.usage.outputTokens} out, ` +
            `${summary.usage.durationMs}ms, $${summary.usage.costUsd.toFixed(4)}`,
        );
        onEvent({ kind: 'summary', path: file.path, summary: summary.text, cached: false, usage: summary.usage });
      } catch (error) {
        if (error instanceof ProviderError && error.kind === 'cancelled') return;
        if (error instanceof Error && error.name === 'AbortError') return;

        const reason = error instanceof Error ? error.message : String(error);
        tally.failed += 1;
        deps.log(`  ${file.path}: failed — ${reason}`);
        onEvent({ kind: 'failed', path: file.path, reason });
      }
    }),
  );

  return tally;
}

function acceptSummary(text: string): Accepted<string> {
  const parsed = parse<{ summary: string }>(text, summaryPrompt.shape);
  if (!parsed.ok) return { ok: false, error: parsed.error, repairable: true };
  const summary = parsed.value.summary.trim();
  return summary ? { ok: true, value: summary } : { ok: false, error: 'the summary was empty', repairable: false };
}

export function isWorthSummarising(file: FileChange): boolean {
  if (file.binary) return false;
  if (file.hunks.some((hunk) => hunk.scaffolding)) return false;
  return file.hunks.some((hunk) => hunk.kind === 'text');
}

/** One file's change, as the model sees it. Budgeted, and structured before it is trimmed. */
export function describeFile(file: FileChange): string {
  const header = [
    `File: ${file.path}`,
    `Status: ${file.status}${file.oldPath ? ` from ${file.oldPath}` : ''}`,
    `Changes: +${file.stats.added} -${file.stats.removed} across ${file.hunks.length} hunk${
      file.hunks.length === 1 ? '' : 's'
    }`,
    '',
  ];

  const body: string[] = [];
  let budget = MAX_INPUT_CHARS - header.join('\n').length;

  for (const hunk of file.hunks) {
    if (hunk.kind !== 'text') {
      body.push(`@@ ${hunk.lines[0] ?? hunk.kind} @@`);
      continue;
    }
    const block = [`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`, ...hunk.lines];
    const text = block.join('\n');
    if (text.length > budget) {
      // Shed the detail, never the structure: a hunk the model never sees is a hunk it
      // cannot account for.
      body.push(`${block[0]} (${hunk.stats.added} added, ${hunk.stats.removed} removed, not shown)`);
      continue;
    }
    budget -= text.length;
    body.push(text);
  }

  return [...header, ...body].join('\n');
}
