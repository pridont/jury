import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClaudeProvider } from '../../src/agent/providers/claude.js';
import { askTrail } from '../../src/agent/trail.js';
import { buildTrail } from '../../src/model/trail.js';

/**
 * Does a real model lay out a trail a person can follow, through this repository?
 *
 * Judged on what can be checked: every span is real code, of a readable size, and the files
 * the answer has to pass through are on it. Not cached: the model reads the repository as
 * it is now, and a cached trail would be judged against code that has since moved.
 */
const root = path.resolve('.');
const read = (file: string) => {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8').split('\n');
  } catch {
    return null;
  }
};

const CASES = [
  { question: 'How are review marks saved, and restored when a review is opened again?', through: ['src/state/store.ts'] },
  { question: 'How does a hunk keep its mark after a rebase?', through: ['src/git/identity.ts', 'src/state/'] },
];

describe('trail', () => {
  for (const { question, through } of CASES) {
    it(question, async () => {
      const provider = new ClaudeProvider();
      expect((await provider.available()).ok, 'claude must be available to run the eval').toBe(true);

      const tools: string[] = [];
      const result = await askTrail(provider, root, question, new AbortController().signal, (label) => tools.push(label));
      expect(result.ok, result.ok ? '' : result.reason).toBe(true);
      if (!result.ok) return;

      const { steps, summary } = result.trail;
      const spans = steps.flatMap((step) => step.spans);
      const built = buildTrail(steps, read);
      console.log(
        `\n=== ${question} ===\n${summary}\n` +
          steps.map((s, i) => `  ${i + 1}. ${s.title}  ${s.spans.map((p) => `${p.path}:${p.start}-${p.end}`).join(' ')}`).join('\n') +
          `\n  ${tools.length} tool calls, $${result.usage.costUsd.toFixed(4)}`,
      );

      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(steps.length).toBeLessThanOrEqual(8);
      // Every span is a file that exists, and lands inside it: nothing was dropped or clamped.
      expect(built.cohorts).toHaveLength(steps.length);
      for (const span of spans) {
        const lines = read(span.path);
        expect(lines, `${span.path} exists`).not.toBeNull();
        expect(span.end, `${span.path}:${span.start}-${span.end} inside the file`).toBeLessThanOrEqual(lines!.length);
        expect(span.end - span.start + 1, `${span.path}:${span.start}-${span.end} readable`).toBeLessThanOrEqual(80);
      }
      for (const place of through) expect(spans.some((span) => span.path.startsWith(place)), `passes through ${place}`).toBe(true);
    });
  }
});

const TOURS = [
  { scope: 'the whole repository', through: ['src/git/', 'src/model/', 'src/agent/', 'src/ui/'] },
  { scope: 'the folder src/agent/', through: ['src/agent/'] },
];

describe('tour', () => {
  for (const { scope, through } of TOURS) {
    it(scope, async () => {
      const provider = new ClaudeProvider();
      expect((await provider.available()).ok, 'claude must be available to run the eval').toBe(true);

      let tools = 0;
      const result = await askTrail(provider, root, scope, new AbortController().signal, () => tools++, 'tour');
      expect(result.ok, result.ok ? '' : result.reason).toBe(true);
      if (!result.ok) return;

      const { steps, summary, diagram } = result.trail;
      const built = buildTrail(steps, read);
      console.log(
        `\n=== tour of ${scope} ===\n${summary}\n${diagram ?? '(no diagram)'}\n` +
          built.cohorts
            .map((c, i) => `  ${i + 1}. ${c.title}\n${c.layers.map((l) => `       - ${l.title}`).join('\n')}`)
            .join('\n') +
          `\n  ${steps.length} stops, ${tools} tool calls, $${result.usage.costUsd.toFixed(4)}`,
      );

      // Areas, each read in one go: an area that comes back later is a tour that wanders.
      const areas = steps.map((step) => step.area ?? '');
      const visits = areas.filter((area, i) => area !== areas[i - 1]);
      expect(areas.every(Boolean), 'every stop is in an area').toBe(true);
      expect(new Set(visits).size, `each area visited once: ${visits.join(' → ')}`).toBe(visits.length);
      expect(visits.length).toBeGreaterThanOrEqual(2);
      expect(visits.length).toBeLessThanOrEqual(7);
      expect(diagram, 'a diagram that parses').toMatch(/^flowchart/);

      const spans = steps.flatMap((step) => step.spans);
      for (const span of spans) {
        const lines = read(span.path);
        expect(lines, `${span.path} exists`).not.toBeNull();
        expect(span.end, `${span.path}:${span.start}-${span.end} inside the file`).toBeLessThanOrEqual(lines!.length);
        expect(span.end - span.start + 1, `${span.path}:${span.start}-${span.end} readable`).toBeLessThanOrEqual(80);
      }
      for (const place of through) expect(spans.some((span) => span.path.startsWith(place)), `passes through ${place}`).toBe(true);
    });
  }
});
