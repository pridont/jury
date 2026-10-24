import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildTrail } from '../../src/model/trail.js';
import { askTrail } from '../../src/agent/trail.js';
import { acquire } from '../../src/git/source.js';
import type { Provider } from '../../src/agent/provider.js';
import type { Repo } from '../../src/git/repo.js';

const FILE = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const read = (file: string) => (file === 'a.ts' ? FILE : null);

describe('buildTrail', () => {
  it('turns each span into a hunk of unchanged lines, and each step into a cohort', () => {
    const { files, cohorts } = buildTrail(
      [
        { title: 'Start', summary: 'Here.', spans: [{ path: 'a.ts', start: 6, end: 7 }] },
        { title: 'Then', summary: 'There.', spans: [{ path: 'a.ts', start: 2, end: 3 }] },
      ],
      read,
    );

    expect(files).toHaveLength(1);
    expect(files[0]!.status).toBe('unchanged');
    // In file order, whatever the reading order.
    expect(files[0]!.hunks.map((h) => [h.newStart, h.newCount, h.lines])).toEqual([
      [2, 2, [' line 2', ' line 3']],
      [6, 2, [' line 6', ' line 7']],
    ]);
    expect(cohorts.map((c) => c.title)).toEqual(['Start', 'Then']);
    expect(cohorts[0]!.layers[0]!.hunkIds).toEqual([files[0]!.hunks[1]!.id]);
  });

  it('clamps spans to the file and drops what is not there', () => {
    const { files, cohorts } = buildTrail(
      [
        { title: 'Past the end', summary: '', spans: [{ path: 'a.ts', start: 9, end: 40 }] },
        { title: 'No such file', summary: '', spans: [{ path: 'gone.ts', start: 1, end: 2 }] },
        { title: 'Backwards', summary: '', spans: [{ path: 'a.ts', start: 5, end: 4 }] },
      ],
      read,
    );
    expect(files[0]!.hunks.map((h) => [h.newStart, h.newCount])).toEqual([[9, 2]]);
    expect(cohorts.map((c) => c.title)).toEqual(['Past the end']);
  });

  it('reads the steps of one area together, as layers of one cohort', () => {
    const at = (start: number) => [{ path: 'a.ts', start, end: start }];
    const { cohorts } = buildTrail(
      [
        { area: 'Core', title: 'Types', summary: 'T.', spans: at(1) },
        { area: 'Core', title: 'Ids', summary: 'I.', spans: at(2) },
        { area: 'UI', title: 'Tree', summary: 'Tr.', spans: at(3) },
        { area: 'Core', title: 'Back again', summary: 'B.', spans: at(4) },
      ],
      read,
    );
    expect(cohorts.map((c) => [c.title, c.summary, c.layers.map((l) => l.title)])).toEqual([
      ['Core', '', ['Types', 'Ids']],
      // One stop is one row, so it carries both names, and speaks for its stop.
      ['UI: Tree', 'Tr.', ['Tree']],
      // An area named again later is a new visit, not a jump back up the tree.
      ['Core: Back again', 'B.', ['Back again']],
    ]);
  });

  it('keeps the same lines named twice as two spans with their own ids', () => {
    const span = { path: 'a.ts', start: 1, end: 1 };
    const { files, cohorts } = buildTrail(
      [
        { title: 'One', summary: '', spans: [span] },
        { title: 'Two', summary: '', spans: [span] },
      ],
      read,
    );
    const [first, second] = cohorts.map((c) => c.layers[0]!.hunkIds[0]);
    expect(first).not.toBe(second);
    expect(files[0]!.hunks).toHaveLength(2);
  });
});

describe('acquire a trail', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jury-trail-')));
    await fs.mkdir(path.join(dir, 'repo'));
    await fs.writeFile(path.join(dir, 'repo', 'a.ts'), 'one\ntwo\n');
    await fs.writeFile(path.join(dir, 'secret.txt'), 'outside\n');
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('reads the working tree, and nothing outside the repository', async () => {
    const repo = { root: path.join(dir, 'repo') } as Repo;
    const acquired = await acquire(repo, {
      kind: 'trail',
      question: 'q',
      summary: '',
      steps: [
        { title: 'In', summary: '', spans: [{ path: 'a.ts', start: 1, end: 2 }] },
        { title: 'Out', summary: '', spans: [{ path: '../secret.txt', start: 1, end: 1 }] },
        { title: 'Absolute', summary: '', spans: [{ path: path.join(dir, 'secret.txt'), start: 1, end: 1 }] },
      ],
    });
    expect(acquired.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(acquired.cohorts?.map((c) => c.title)).toEqual(['In']);
  });
});

describe('askTrail', () => {
  const answering = (text: string) =>
    ({
      stream: async () => ({ text, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }, model: 'm' }),
    }) as unknown as Provider;
  const ask = (text: string) => askTrail(answering(text), '/repo', 'q', new AbortController().signal, () => {});

  it('keeps the steps that point at code, and tidies their paths', async () => {
    const result = await ask(
      JSON.stringify({
        summary: 'S.',
        steps: [
          { title: 'Good', summary: 'x', spans: [{ path: './a.ts', start: 1, end: 2 }, { path: 'b.ts' }] },
          { title: 'Empty', summary: 'x', spans: [] },
          'nonsense',
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      trail: { summary: 'S.', steps: [{ title: 'Good', spans: [{ path: 'a.ts', start: 1, end: 2 }] }] },
    });
  });

  it('keeps a tour\'s areas and a diagram that parses, and drops one that does not', async () => {
    const tour = (diagram: string) =>
      askTrail(
        answering(
          JSON.stringify({
            summary: 'S.',
            diagram,
            steps: [{ area: ' Core ', title: 'T', summary: '', spans: [{ path: 'a.ts', start: 1, end: 2 }] }],
          }),
        ),
        '/repo',
        'the whole repository',
        new AbortController().signal,
        () => {},
        'tour',
      );
    expect(await tour('flowchart TD\n  a --> b')).toMatchObject({
      ok: true,
      trail: { diagram: 'flowchart TD\n  a --> b', steps: [{ area: 'Core' }] },
    });
    const without = await tour('a picture of the code');
    expect(without.ok && 'diagram' in without.trail).toBe(false);
  });

  it('cuts a span to what is read in one look, whatever the model asked for', async () => {
    const result = await ask(
      JSON.stringify({ summary: 'S.', steps: [{ title: 'Long', summary: '', spans: [{ path: 'a.ts', start: 10, end: 400 }] }] }),
    );
    expect(result).toMatchObject({ ok: true, trail: { steps: [{ spans: [{ start: 10, end: 89 }] }] } });
  });

  it('says so when there is no trail in the answer', async () => {
    expect(await ask('I could not find it.')).toMatchObject({ ok: false });
    expect(await ask(JSON.stringify({ summary: 'S.', steps: [] }))).toMatchObject({ ok: false });
  });
});
