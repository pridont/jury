import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { Cache } from '../../src/agent/cache.js';
import { Queue } from '../../src/agent/queue.js';
import { clusterChange } from '../../src/agent/cluster.js';
import { askQuestions } from '../../src/agent/questions.js';
import { ClaudeProvider } from '../../src/agent/providers/claude.js';
import { VERDICT } from '../../src/model/questions.js';
import { load } from './harness.js';

/**
 * Are the questions questions, from perspectives that differ, about what the change turns on?
 *
 * `auth-clock` moves the expiry boundary from `<` to `<=` and threads a `Clock` through, so a
 * reader worth helping is pointed at the exact-expiry second or at where the time comes from.
 * The answer is checked after the validation in `questionsOf` too, so a prompt that leans on
 * that validation to hide its verdicts shows up as questions going missing.
 */
const cache = new Cache(path.resolve('test/eval/.cache'));

describe('questions to check', () => {
  it('auth-clock', async () => {
    const fixture = load('auth-clock');
    const provider = new ClaudeProvider();
    expect((await provider.available()).ok, 'claude must be available to run the eval').toBe(true);

    const log: string[] = [];
    const deps = { provider, queue: new Queue(2), cache, owner: 'eval', log: (line: string) => log.push(line) };
    const grouped = await clusterChange(deps, fixture.files, new Map());
    expect(grouped.ok, grouped.ok ? '' : `declined: ${grouped.reason}`).toBe(true);
    if (!grouped.ok) return;

    const result = await askQuestions(deps, grouped.merged.cohorts, fixture.files);
    expect(result.ok, result.ok ? '' : `declined: ${result.reason}`).toBe(true);
    if (!result.ok) return;

    console.log(
      '\n' +
        grouped.merged.cohorts
          .map(
            (c) =>
              `  ${c.title}\n` +
              (result.questions.get(c) ?? []).map((q) => `    - ${q.perspective}: ${q.question}`).join('\n'),
          )
          .join('\n') +
        `\n  ${log.find((line) => line.includes('questions:')) ?? '(cached)'}`,
    );

    const asked = grouped.merged.cohorts.filter((c) => c.kind !== 'scaffolding' && c.kind !== 'unclassified');
    const all = [...result.questions.values()].flat();

    // Most cohorts get questions, and two or three each once validation has had its say.
    expect(result.questions.size, 'cohorts with questions').toBeGreaterThanOrEqual(Math.ceil(asked.length / 2));
    for (const [cohort, questions] of result.questions) {
      expect(questions.length, `questions on "${cohort.title}"`).toBeGreaterThanOrEqual(2);
      expect(new Set(questions.map((q) => q.perspective.toLowerCase())).size, 'distinct perspectives').toBe(
        questions.length,
      );
    }

    for (const { question } of all) {
      expect(question.endsWith('?'), question).toBe(true);
      expect(VERDICT.test(question), `a verdict: ${question}`).toBe(false);
      expect(question, 'no hunk or cohort labels').not.toMatch(/\b[hc]\d+\b/);
    }

    // The thing this change turns on is asked about.
    expect(
      all.some((q) => /(<=|exactly|equal|boundary|same second|clock|Date\.now|now\(\))/i.test(q.question)),
      'a question about the exact-expiry boundary or the clock',
    ).toBe(true);
  });
});
