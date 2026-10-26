import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cache } from '../../src/agent/cache.js';
import { Queue } from '../../src/agent/queue.js';
import { askQuestions } from '../../src/agent/questions.js';
import type { Answer, Provider } from '../../src/agent/provider.js';
import { MAX_QUESTIONS, questionsOf } from '../../src/model/questions.js';
import type { FileChange } from '../../src/git/parse.js';
import type { Cohort, Hunk } from '../../src/model/types.js';

const hunk = (id: string, path: string, body: string): Hunk => ({
  id,
  path,
  oldStart: 1,
  oldCount: 1,
  newStart: 1,
  newCount: 1,
  lines: [`+${body}`],
  stats: { added: 1, removed: 0 },
  kind: 'text',
});

const cohort = (id: string, title: string, hunkIds: string[], kind: Cohort['kind'] = 'fix'): Cohort => ({
  id,
  title,
  summary: `${title}.`,
  kind,
  risk: 'low',
  origin: 'ai',
  layers: [{ id: `${id}l1`, title, summary: '', hunkIds, paths: ['a.ts'] }],
});

const expiry = cohort('c1', 'Reject tokens expiring exactly now', ['ha']);
const tests = cohort('c2', 'Test the boundary', ['hb'], 'test');
const labels = new Map([
  ['c1', expiry],
  ['c2', tests],
]);

const q = (perspective: string, question: string) => ({ perspective, question });

describe('questionsOf', () => {
  it('keeps questions with a perspective that end in a question mark', () => {
    const found = questionsOf(
      {
        cohorts: [
          {
            id: 'c1',
            questions: [
              q('caller', 'What does isExpired return when exp equals now?'),
              q('', 'What happens when exp is undefined?'),
              q('tester', 'Which test pins the clock'),
              { question: 'Where is the clock set?' },
              'not an object',
            ],
          },
        ],
      },
      labels,
    );
    expect(found.get('c1')).toEqual([q('caller', 'What does isExpired return when exp equals now?')]);
  });

  it('keeps one question per perspective, so they do not overlap', () => {
    const found = questionsOf(
      {
        cohorts: [
          {
            id: 'c1',
            questions: [
              q('caller', 'What does isExpired return when exp equals now?'),
              q('Caller', 'What does authenticate return for an expired token?'),
              q('operator', 'Which clock does production use?'),
            ],
          },
        ],
      },
      labels,
    );
    expect(found.get('c1')?.map((x) => x.perspective)).toEqual(['caller', 'operator']);
  });

  it(`caps a cohort at ${MAX_QUESTIONS}`, () => {
    const many = ['caller', 'tester', 'operator', 'security', 'reader'].map((p) => q(p, `What does ${p} see?`));
    expect(questionsOf({ cohorts: [{ id: 'c1', questions: many }] }, labels).get('c1')).toHaveLength(MAX_QUESTIONS);
  });

  it('drops a finding dressed as a question', () => {
    const verdicts = [
      'Is this a bug when exp is null?',
      'Should isExpired accept a null exp?',
      'Is the <= comparison correct?',
      'Would it be better to inject the clock?',
      'Consider a monotonic clock?',
      'Is it safe to default to systemClock?',
      'Was the change to <= intended?',
    ];
    const found = questionsOf(
      { cohorts: [{ id: 'c1', questions: verdicts.map((v, i) => q(`p${i}`, v)) }] },
      labels,
    );
    expect(found.has('c1')).toBe(false);
  });

  it('replaces a leaked cohort label with the cohort it stands for', () => {
    const found = questionsOf(
      { cohorts: [{ id: 'c2', questions: [q('tester', 'Which case in c2 covers the boundary c1 moves?')] }] },
      labels,
    );
    expect(found.get('c2')?.[0]?.question).toBe(
      'Which case in "Test the boundary" covers the boundary "Reject tokens expiring exactly now" moves?',
    );
  });

  it('ignores a cohort it was not asked about, and a repeated one', () => {
    const found = questionsOf(
      {
        cohorts: [
          { id: 'c9', questions: [q('caller', 'What now?')] },
          { id: 'c1', questions: [q('caller', 'First?')] },
          { id: 'c1', questions: [q('tester', 'Second?')] },
        ],
      },
      labels,
    );
    expect([...found.keys()]).toEqual(['c1']);
    expect(found.get('c1')).toEqual([q('caller', 'First?')]);
  });
});

describe('askQuestions', () => {
  let dir: string;
  let calls: string[];
  let reply: string;
  const files = [
    { path: 'a.ts', hunks: [hunk('ha', 'a.ts', 'return exp <= now;'), hunk('hb', 'a.ts', 'it("expires")')] },
    { path: 'yarn.lock', hunks: [{ ...hunk('hs', 'yarn.lock', 'x'), scaffolding: { reason: 'lockfile' } }] },
  ] as unknown as FileChange[];
  const scaffolding = cohort('c-scaffolding', 'Scaffolding', ['hs'], 'scaffolding');

  const provider: Provider = {
    id: 'stub',
    capabilities: () => ({ repoTools: false, models: { smart: 'stub-smart' }, maxInputChars: 100_000 }),
    available: async () => ({ ok: true }),
    structured: async (request): Promise<Answer> => {
      calls.push(request.input);
      return { text: reply, model: 'stub-smart', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, durationMs: 1 } };
    },
    stream: async () => {
      throw new Error('not used');
    },
  };
  const deps = () => ({ provider, queue: new Queue(1), cache: new Cache(dir), owner: 'r', log: () => {} });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jury-questions-'));
    calls = [];
    reply = JSON.stringify({ cohorts: [{ id: 'c1', questions: [q('caller', 'What does isExpired return at exp = now?')] }] });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('asks once for every cohort but scaffolding, and hands questions back by cohort', async () => {
    const result = await askQuestions(deps(), [expiry, tests, scaffolding], files);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('# Cohort c1');
    expect(calls[0]).toContain('# Cohort c2');
    expect(calls[0]).toContain('+return exp <= now;');
    expect(calls[0]).not.toContain('yarn.lock');
    expect(calls[0]).not.toContain('The reviewer is on');
    expect(result.ok && result.questions.get(expiry)).toEqual([q('caller', 'What does isExpired return at exp = now?')]);
  });

  it('serves the second ask from the cache', async () => {
    await askQuestions(deps(), [expiry, tests], files);
    const again = await askQuestions(deps(), [expiry, tests], files);
    expect(calls).toHaveLength(1);
    expect(again).toMatchObject({ ok: true, cached: true });
  });

  it('declines an answer with nothing usable in it, and does not cache it', async () => {
    reply = JSON.stringify({ cohorts: [{ id: 'c1', questions: [q('caller', 'Is this a bug?')] }] });
    expect(await askQuestions(deps(), [expiry, tests], files)).toMatchObject({ ok: false });
    await askQuestions(deps(), [expiry, tests], files);
    expect(calls).toHaveLength(2);
  });
});
