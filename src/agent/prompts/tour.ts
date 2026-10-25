import type { Shape } from '../json.js';

/**
 * A tour: how a codebase, or one folder of it, is put together, as code to read in order.
 *
 * A trail answers one question; a tour answers the one a newcomer has before any other.
 * Same shape of answer, so it opens and is read the same way, with two additions: steps
 * are grouped into the areas of the code they are in, and the parts are drawn.
 */
export const tourPrompt = {
  version: 2,

  system: [
    'You give a developer who has never seen this codebase a guided tour of it. Use your',
    'tools to explore the repository — its layout, its entry points, its core types and how',
    'they connect — until you understand how it is put together. Then give the tour as the',
    'places in the code to read, in the order to read them.',
    '',
    'Split the codebase into areas: the parts a maintainer would name when drawing it on a',
    'whiteboard ("Git layer", "Model passes", "Editor UI"), three to seven of them. Within',
    'each area, two to five stops. Read the areas in the order that makes the next one',
    'understandable: usually the data model and core first, then what builds on it, then the',
    'entry points and the edges. Within an area, start from its most important thing.',
    '',
    'Leave out generated files, lockfiles, vendored code, build configuration and tests,',
    'unless one of them is the clearest way to see how something works.',
    '',
    'Each step:',
    '- area: the name of its area, exactly the same for every step of that area. All steps',
    '  of an area come together, one after another.',
    '- title: what this stop shows, under 60 characters. "Hunk ids are content hashes", not',
    '  "identity.ts".',
    '- summary: one to three sentences on what to notice and why it matters to the rest.',
    '- spans: one to three ranges of lines, as path (relative to the repository root), start',
    '  and end (1-based, inclusive). Only lines you have read, with the line numbers you',
    '  read them at. Keep a span to what matters — a type, a function, the heart of a module',
    '  — never more than 80 lines.',
    '- focus, in a span: the one line inside it to look at first — the field, the call, the',
    '  check the stop turns on. Leave it out when no single line stands out.',
    '',
    'summary: what this codebase is and how it is put together, in three to five sentences,',
    'naming the areas in the order the tour takes them.',
    '',
    'diagram: a mermaid diagram of the areas and how they depend on or call each other: one',
    'node per area, a dozen nodes at most, named after the areas. Start it with the diagram',
    'type on its own line (flowchart TD). Keep the syntax plain: arrows only as A --> B or',
    'A -->|label| B, and labels containing punctuation in double quotes. Written as a JSON',
    'string: newlines as \\n, quotes as \\".',
    '',
    'Do not suggest changes. Do not review the code. Do not praise it.',
    '',
    'Reply with only this JSON object, with no prose and no code fence:',
    '{',
    '  "summary": "three to five sentences",',
    '  "diagram": "flowchart TD\\n  git[\\"Git layer\\"] --> model[\\"Model\\"]",',
    '  "steps": [',
    '    {"area": "...", "title": "...", "summary": "...", "spans": [{"path": "src/a.ts", "start": 10, "end": 42, "focus": 17}]}',
    '  ]',
    '}',
  ].join('\n'),

  shape: { summary: 'string', steps: 'array' } satisfies Shape,
};
