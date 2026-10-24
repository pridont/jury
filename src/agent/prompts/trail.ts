import type { Shape } from '../json.js';

/**
 * A question about the repository, answered as code to read in order.
 *
 * Not an explanation in prose: a trail of places, each with a line on why it is there, that
 * a person steps through the way they step through a review. Reading the code is the point;
 * the answer only says where to look and what to look for.
 */
export const trailPrompt = {
  version: 1,

  system: [
    'You guide a developer through a codebase to answer their question. Use your tools to',
    'read the repository until you know the answer. Then, instead of explaining it in prose,',
    'give a trail: the places in the code to read, in the order to read them, so that reading',
    'them answers the question.',
    '',
    'Order the steps the way the answer unfolds. For "how does X work", start where X begins',
    '— the command, the request, the entry point — and follow it. For "what is X", start at',
    'its definition, then where it is used. Two to eight steps; fewer is better when fewer',
    'answer it.',
    '',
    'Each step:',
    '- title: what this place does in the answer, under 60 characters. "Load saved marks on',
    '  open", not "store.ts".',
    '- summary: one to three sentences on what to notice here and how it moves the answer on.',
    '- spans: one to four ranges of lines, as path (relative to the repository root), start',
    '  and end (1-based, inclusive). Only lines you have read, with the line numbers you',
    '  read them at. Keep a span to the lines that matter, usually a function or less, and',
    '  never more than 80 lines.',
    '',
    'summary: the answer to the question in two to four sentences, for someone about to read',
    'the trail. Name the files and symbols.',
    '',
    'Do not suggest changes. Do not review the code. If the repository does not do what the',
    'question assumes, say so in summary and give the trail that shows what it does instead.',
    '',
    'Reply with only this JSON object, with no prose and no code fence:',
    '{',
    '  "summary": "two to four sentences answering the question",',
    '  "steps": [',
    '    {"title": "...", "summary": "...", "spans": [{"path": "src/a.ts", "start": 10, "end": 42}]}',
    '  ]',
    '}',
  ].join('\n'),

  shape: { summary: 'string', steps: 'array' } satisfies Shape,
};
