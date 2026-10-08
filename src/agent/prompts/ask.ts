import type { FileChange } from '../../git/parse.js';
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
 * What the model is asked about. A hunk or a step is sent as it always was; a cohort can be
 * most of the change, so its hunks share `budget` in reading order and the ones that do not
 * fit are named but not shown. The model can read those from the repository, and is told
 * which they are rather than left to assume it saw everything.
 */
export function askContext(entry: Entry, scope: AskScope, files: readonly FileChange[], budget: number): string {
  const lines: string[] = [`Change being reviewed: ${entry.cohort.title}`, entry.cohort.summary, ''];

  if (scope === 'step') {
    lines.push(`Step: ${entry.layer.title}`, entry.layer.summary, `Files: ${entry.layer.paths.join(', ')}`, '');
  }

  if (scope !== 'cohort') {
    lines.push(...hunkBlock(entry.hunk));
    return lines.join('\n');
  }

  const byId = new Map(files.flatMap((file) => file.hunks.map((hunk) => [hunk.id, hunk] as const)));
  let left = budget;
  let hidden = 0;
  entry.cohort.layers.forEach((layer, index) => {
    lines.push(`Step ${index + 1}: ${layer.title}`, layer.summary, `Files: ${layer.paths.join(', ')}`, '');
    for (const id of layer.hunkIds) {
      const hunk = byId.get(id);
      if (!hunk) continue;
      const block = hunkBlock(hunk);
      const size = block.join('\n').length;
      if (size > left) {
        // Shed the detail, never the structure: a hunk the model is not told about is one
        // it cannot know to go and read.
        hidden += 1;
        lines.push(`${block[0]} ${block[1]} (${hunk.stats.added} added, ${hunk.stats.removed} removed, not shown)`, '');
        continue;
      }
      left -= size;
      lines.push(...block, '');
    }
  });

  lines.push(`The reviewer is on the hunk in ${entry.hunk.path}:${entry.hunk.newStart}.`);
  if (hidden > 0) {
    lines.push(
      `${hidden} hunk${hidden === 1 ? ' is' : 's are'} not shown, to keep this short. ` +
        'Read them from the repository if the question needs them.',
    );
  }
  return lines.join('\n');
}

function hunkBlock(hunk: Hunk): string[] {
  return [
    `Hunk in ${hunk.path}${hunk.symbol ? `, in ${hunk.symbol}` : ''}:`,
    `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    ...hunk.lines,
  ];
}
