import type { Entry } from '../../model/order.js';
import type { Hunk } from '../../model/types.js';

/**
 * Pass 3: answering a question about the change being read.
 *
 * The only prompt with tools. It exists because the diff alone often cannot settle a
 * question — whether a caller outside the diff still relies on the old behaviour, whether a
 * case is handled somewhere else — and reading the repository is how you find out.
 */
export const askPrompt = {
  version: 1,

  system: [
    'You answer a reviewer\'s questions about a change they are reading. You are given the',
    'change and the question. You can read the repository around it with the tools you have;',
    'use them when the diff alone cannot settle the question — to check a caller, a',
    'definition, or whether a case is handled elsewhere.',
    '',
    'Answer the question that was asked, in as few words as it takes. Say what you found and',
    'where, with paths and symbols. If the answer is "the diff does not say", say that and',
    'say what would settle it. If you looked and the thing is not there, that is an answer:',
    'report it plainly rather than hedging.',
    '',
    'Do not summarise the change back to the reviewer — they are reading it. Do not review',
    'the code unless the question asks you to. Do not praise it. Do not suggest refactors.',
    '',
    'You cannot edit anything, and should not offer to.',
  ].join('\n'),
};

/** How much of the change a question is about: the hunk, its step, or its whole cohort. */
export type AskScope = 'hunk' | 'step' | 'cohort';

/**
 * What the model is asked about. A hunk is sent as it always was; a step or a cohort can be
 * most of the change, so everything sent shares `budget` and the hunks that do not fit are
 * named but not shown. The current hunk is paid for first, so it is never the one shed. The
 * model can read the rest from the repository, and is told which they are rather than left
 * to assume it saw everything.
 */
export function askContext(entry: Entry, scope: AskScope, order: readonly Entry[], budget: number): string {
  if (scope === 'hunk') return [...header(entry), ...hunkBlock(entry.hunk)].join('\n');

  const inScope = order.filter(
    (other) =>
      other.cohortIndex === entry.cohortIndex && (scope === 'cohort' || other.layerIndex === entry.layerIndex),
  );
  // Shed the detail, never the structure: a hunk the model is not told about is one it
  // cannot know to go and read. So the structure is paid for up front, and showing a hunk
  // costs only what its body adds over its stub.
  const shown = new Set<Entry>();
  let left = budget - render(entry, inScope, shown).length;
  for (const candidate of [entry, ...inScope.filter((other) => other !== entry)]) {
    const extra = hunkBlock(candidate.hunk).join('\n').length - stub(candidate.hunk).length;
    if (extra > left) continue;
    shown.add(candidate);
    left -= extra;
  }
  return render(entry, inScope, shown);
}

function render(entry: Entry, inScope: readonly Entry[], shown: ReadonlySet<Entry>): string {
  const lines = header(entry);
  let layer = -1;
  for (const other of inScope) {
    if (other.layerIndex !== layer) {
      layer = other.layerIndex;
      lines.push(`Step ${layer + 1}: ${other.layer.title}`, other.layer.summary, `Files: ${other.layer.paths.join(', ')}`, '');
    }
    lines.push(...(shown.has(other) ? hunkBlock(other.hunk) : [stub(other.hunk)]), '');
  }

  lines.push(`The reviewer is on the hunk in ${entry.hunk.path}:${entry.hunk.newStart}.`);
  const hidden = inScope.length - shown.size;
  if (hidden > 0) {
    lines.push(
      `${hidden} hunk${hidden === 1 ? ' is' : 's are'} not shown, to keep this short. ` +
        'Read them from the repository if the question needs them.',
    );
  }
  return lines.join('\n');
}

function header(entry: Entry): string[] {
  return [`Change being reviewed: ${entry.cohort.title}`, entry.cohort.summary, ''];
}

function stub(hunk: Hunk): string {
  const [title, range] = hunkBlock(hunk);
  return `${title} ${range} (${hunk.stats.added} added, ${hunk.stats.removed} removed, not shown)`;
}

function hunkBlock(hunk: Hunk): string[] {
  return [
    `Hunk in ${hunk.path}${hunk.symbol ? `, in ${hunk.symbol}` : ''}:`,
    `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    ...hunk.lines,
  ];
}
