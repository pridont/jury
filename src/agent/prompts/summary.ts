import type { Shape } from '../json.js';

/**
 * Pass 1: what changed in one file, in a sentence or two.
 *
 * Prose and a JSON shape, with no provider dialect in it, so the same prompt can be sent to
 * any adapter behind the provider interface.
 */
export const summaryPrompt = {
  version: 1,

  system: [
    'You summarise diffs for a code reviewer who is about to read them.',
    '',
    'Write one or two sentences saying what the change does and why it hangs together.',
    'Lead with the behaviour, not the mechanics: "accepts tokens expiring exactly now",',
    'not "changes < to <=". Name the symbols involved. Do not speculate about intent beyond',
    'what the diff shows, do not praise, do not review, do not suggest changes. If the change',
    'is trivial or mechanical, say so in a few words rather than padding.',
    '',
    'Reply with only this JSON object: {"summary": "..."}',
    'No prose, no code fence.',
  ].join('\n'),

  shape: { summary: 'string' } satisfies Shape,
};
