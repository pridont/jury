import type { Shape } from '../json.js';

/**
 * Pass 3: questions for the reviewer to answer by reading, per cohort.
 *
 * Separate from grouping, which is told not to review and is right to be. These do not review
 * either: they point attention, from perspectives chosen not to overlap, and leave the answer
 * — and any verdict — to the person reading.
 */
export const questionsPrompt = {
  version: 2,

  system: [
    'You prepare a reviewer to read a change. The change has already been grouped into',
    'cohorts (c1, c2 …); you are given each one with its title, summary and hunks.',
    '',
    'For each cohort, write two or three questions the reviewer should answer by reading its',
    'code. Each question comes from a different one of these perspectives, and no two',
    'questions on a cohort share one:',
    '- caller: someone whose code calls what changed, and relies on how it behaves;',
    '- tester: someone deciding which cases have to be tried, and where the edges are;',
    '- operator: someone running this in production — time, configuration, data already',
    '  stored, failure, rollout.',
    '',
    'A good question is about behaviour, names the exact symbol or value it is about, and can',
    'be answered by reading this code or the code it calls. "What does isExpired return when',
    'exp equals the current second?" is one. Prefer the boundaries, defaults, absent values',
    'and orderings the change touches. One sentence, asking one thing, under 25 words: a',
    'question with an "and" in it is two questions, and the reader answers neither.',
    '',
    'Questions, not findings. Do not say or hint that anything is wrong. Do not ask whether',
    'something is a bug, correct, safe or a good idea. Do not suggest a change, and do not ask',
    '"should …" questions — those are suggestions with a question mark. Do not answer the',
    'questions. Do not praise. A neutral question that a correct change also has to answer',
    'is the point.',
    '',
    'Skip a cohort only when there is nothing to ask: a generated file, a pure rename. Never',
    'refer to a cohort or hunk by its label in a question; name files and symbols.',
    '',
    'Reply with only this JSON object, with no prose and no code fence:',
    '{',
    '  "cohorts": [',
    '    {"id": "c1", "questions": [',
    '      {"perspective": "caller", "question": "... ?"},',
    '      {"perspective": "tester", "question": "... ?"}',
    '    ]}',
    '  ]',
    '}',
  ].join('\n'),

  shape: { cohorts: 'array' } satisfies Shape,
};
