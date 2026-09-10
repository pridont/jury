import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse, repairPrompt, salvage, stripFence } from '../../src/agent/json.js';
import { Cache } from '../../src/agent/cache.js';
import { Queue } from '../../src/agent/queue.js';
import { describeFile, summariseFiles } from '../../src/agent/summaries.js';
import { ProviderError, type Answer, type Provider, type Request } from '../../src/agent/provider.js';
import type { FileChange } from '../../src/git/parse.js';

describe('stripFence', () => {
  it('unwraps a fenced object, which models produce even when told not to', () => {
    expect(stripFence('```json\n{"summary": "ok"}\n```')).toBe('{"summary": "ok"}');
    expect(stripFence('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it('leaves a bare object alone', () => {
    expect(stripFence('{"a": 1}')).toBe('{"a": 1}');
  });

  it('rescues an object wrapped in prose', () => {
    expect(stripFence('Sure! {"a": 1} Hope that helps.')).toBe('{"a": 1}');
  });
});

describe('parse', () => {
  it('accepts an answer that matches the contract', () => {
    const result = parse<{ summary: string }>('{"summary":"x"}', { summary: 'string' });
    expect(result).toEqual({ ok: true, value: { summary: 'x' } });
  });

  it('names the missing field, so a repair can quote it', () => {
    const result = parse('{"other":1}', { summary: 'string' });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain('missing field "summary"');
  });

  it('names the wrong type', () => {
    const result = parse('{"summary":[]}', { summary: 'string' });
    expect((result as { error: string }).error).toBe('field "summary" should be string, got array');
  });

  it('refuses an array at the top level', () => {
    expect(parse('[1,2]', {})).toMatchObject({ ok: false });
  });

  it('reports unparseable text rather than throwing', () => {
    expect(parse('{ truncated', { summary: 'string' })).toMatchObject({ ok: false });
  });

  it('checks arrays and objects too', () => {
    expect(parse('{"a":[],"b":{}}', { a: 'array', b: 'object' })).toMatchObject({ ok: true });
    expect(parse('{"a":{},"b":{}}', { a: 'array', b: 'object' })).toMatchObject({ ok: false });
  });

  it('builds a repair prompt that carries both the problem and the broken answer', () => {
    const prompt = repairPrompt('missing field "summary"', '{"oops":');
    expect(prompt).toContain('missing field "summary"');
    // Without the answer itself this is not a repair, it is the same question again.
    expect(prompt).toContain('{"oops":');
  });
});

describe('salvage', () => {
  it('escapes a raw newline inside a string, which is how a diagram usually arrives', () => {
    const broken = '{"diagram":"flowchart TD\n  A --> B"}';
    expect(() => JSON.parse(broken)).toThrow();
    expect(JSON.parse(salvage(broken))).toEqual({ diagram: 'flowchart TD\n  A --> B' });
  });

  it('drops a trailing comma', () => {
    expect(JSON.parse(salvage('{"a":[1,2,],}'))).toEqual({ a: [1, 2] });
  });

  it('leaves a correctly escaped string exactly as it was', () => {
    const fine = '{"a":"line\\nline","b":"a \\" quote"}';
    expect(salvage(fine)).toBe(fine);
  });

  it('does not touch newlines between tokens, only inside strings', () => {
    const pretty = '{\n  "a": 1\n}';
    expect(salvage(pretty)).toBe(pretty);
  });

  it('is reached by parse, so a salvageable answer costs no second call', () => {
    const result = parse<{ summary: string }>('{"summary":"one\ntwo"}', { summary: 'string' });
    expect(result).toMatchObject({ ok: true });
  });
});

describe('Cache', () => {
  let dir: string;
  let cache: Cache;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'changestack-cache-'));
    cache = new Cache(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('round-trips an answer', async () => {
    await cache.set('k', 'an answer');
    expect(await cache.get('k')).toBe('an answer');
  });

  it('is null for a key it does not have', async () => {
    expect(await cache.get('missing')).toBeNull();
  });

  it('keys on the prompt version, so editing a prompt invalidates its answers', () => {
    const one = Cache.key({ promptVersion: 1, model: 'haiku', input: 'x' });
    const two = Cache.key({ promptVersion: 2, model: 'haiku', input: 'x' });
    expect(one).not.toBe(two);
  });

  it('keys on the model, so a tier change is not served the old answer', () => {
    expect(Cache.key({ promptVersion: 1, model: 'haiku', input: 'x' })).not.toBe(
      Cache.key({ promptVersion: 1, model: 'sonnet', input: 'x' }),
    );
  });

  it('clears', async () => {
    await cache.set('k', 'v');
    await cache.clear();
    expect(await cache.get('k')).toBeNull();
    expect(await cache.size()).toBe(0);
  });
});

describe('Queue', () => {
  it('runs no more than the cap at once', async () => {
    const queue = new Queue(2);
    let peak = 0;
    let running = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        queue.run('review', async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running -= 1;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('signals a job that is already running', async () => {
    const queue = new Queue(1);
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => (started = resolve));

    const job = queue.run('review', async (signal) => {
      started();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return signal.aborted;
    });

    await running;
    queue.cancel('review');
    expect(await job).toBe(true);
  });

  it('never starts a job cancelled while it waited', async () => {
    const queue = new Queue(1);
    let started = false;

    const blocker = queue.run('a', () => new Promise((resolve) => setTimeout(resolve, 20)));
    const queued = queue.run('b', async () => {
      started = true;
    });

    queue.cancel('b');
    await blocker;
    await expect(queued).rejects.toThrow();
    expect(started).toBe(false);
  });

  it('leaves other reviews alone when one is cancelled', async () => {
    const queue = new Queue(2);
    let aborted = false;
    const other = queue.run('keep', async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      aborted = signal.aborted;
    });
    queue.cancel('drop');
    await other;
    expect(aborted).toBe(false);
  });

  it('reports nothing in flight once it drains', async () => {
    const queue = new Queue(2);
    await Promise.all([queue.run('r', async () => {}), queue.run('r', async () => {})]);
    expect(queue.inFlight).toBe(0);
  });
});

const file = (path: string, over: Partial<FileChange> = {}): FileChange => ({
  path,
  status: 'modified',
  binary: false,
  hunks: [
    {
      id: `h:${path}`,
      path,
      oldStart: 1,
      oldCount: 2,
      newStart: 1,
      newCount: 2,
      lines: [' ctx', '-old', '+new'],
      stats: { added: 1, removed: 1 },
      kind: 'text',
    },
  ],
  stats: { added: 1, removed: 1 },
  ...over,
});

const stub = (answers: (request: Request) => string | Error): Provider => ({
  id: 'stub',
  capabilities: () => ({
    structured: true,
    streaming: false,
    repoTools: false,
    models: { fast: 'stub-fast' },
    maxInputChars: 100_000,
  }),
  available: async () => ({ ok: true }),
  structured: async (request): Promise<Answer> => {
    const answer = answers(request);
    if (answer instanceof Error) throw answer;
    return {
      text: answer,
      model: 'stub-fast',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001, durationMs: 1 },
    };
  },
});

describe('describeFile', () => {
  it('names the file, the status and the counts before any code', () => {
    const text = describeFile(file('src/a.ts'));
    expect(text).toContain('File: src/a.ts');
    expect(text).toContain('Changes: +1 -1 across 1 hunk');
    expect(text).toContain('@@ -1,2 +1,2 @@');
  });

  it('sheds the detail of an oversized hunk but never the hunk itself', () => {
    const huge = file('src/big.ts');
    huge.hunks[0]!.lines = Array.from({ length: 5000 }, (_, i) => `+line ${i}`);
    const text = describeFile(huge);

    expect(text.length).toBeLessThan(20_000);
    expect(text).toContain('@@ -1,2 +1,2 @@');
    expect(text).toContain('not shown');
  });
});

describe('summariseFiles', () => {
  let dir: string;
  let deps: Parameters<typeof summariseFiles>[0];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'changestack-sum-'));
    deps = {
      provider: stub(() => '{"summary":"accepts tokens expiring exactly now"}'),
      queue: new Queue(2),
      cache: new Cache(dir),
      owner: 'review',
      log: () => {},
    };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('hands each summary back as it lands', async () => {
    const events: string[] = [];
    const tally = await summariseFiles(deps, [file('a.ts'), file('b.ts')], (event) => {
      if (event.kind === 'summary') events.push(event.path);
    });

    expect(events.sort()).toEqual(['a.ts', 'b.ts']);
    expect(tally).toMatchObject({ summarised: 2, cached: 0, failed: 0 });
  });

  it('does not spend a call on scaffolding or on a binary file', async () => {
    const scaffolding = file('yarn.lock');
    scaffolding.hunks[0]!.scaffolding = { reason: 'lockfile' };
    const binary = file('logo.png', { binary: true });

    let calls = 0;
    deps.provider = stub(() => {
      calls += 1;
      return '{"summary":"x"}';
    });

    const tally = await summariseFiles(deps, [scaffolding, binary], () => {});
    expect(calls).toBe(0);
    expect(tally.summarised).toBe(0);
  });

  it('serves the second run from cache, with no call at all', async () => {
    let calls = 0;
    deps.provider = stub(() => {
      calls += 1;
      return '{"summary":"once"}';
    });

    await summariseFiles(deps, [file('a.ts')], () => {});
    const second = await summariseFiles(deps, [file('a.ts')], () => {});

    expect(calls).toBe(1);
    expect(second).toMatchObject({ cached: 1, summarised: 0 });
  });

  it('repairs one bad answer, then accepts the second', async () => {
    let call = 0;
    const seenOnRepair: string[] = [];
    deps.provider = stub((request) => {
      call += 1;
      if (call === 1) return 'sorry, {"summary": "half' ;
      seenOnRepair.push(request.input);
      return '{"summary":"recovered"}';
    });

    const seen: string[] = [];
    const tally = await summariseFiles(deps, [file('a.ts')], (event) => {
      if (event.kind === 'summary') seen.push(event.summary);
    });

    expect(call).toBe(2);
    expect(seen).toEqual(['recovered']);
    expect(tally.summarised).toBe(1);
    // The repair carries the broken answer, not the original question.
    expect(seenOnRepair[0]).toContain('half');
    expect(seenOnRepair[0]).not.toContain('File: a.ts');
  });

  it('gives up after one repair rather than looping', async () => {
    let call = 0;
    deps.provider = stub(() => {
      call += 1;
      return 'never valid';
    });

    const tally = await summariseFiles(deps, [file('a.ts')], () => {});
    expect(call).toBe(2);
    expect(tally).toMatchObject({ summarised: 0, failed: 1 });
  });

  it('does not cache an answer the caller rejected', async () => {
    deps.provider = stub(() => '{"summary":"   "}');
    await summariseFiles(deps, [file('a.ts')], () => {});
    expect(await deps.cache.size()).toBe(0);
  });

  it('reports a failure per file and keeps going', async () => {
    deps.provider = stub((request) =>
      request.input.includes('bad.ts') ? new ProviderError('failed', 'boom') : '{"summary":"fine"}',
    );

    const failed: string[] = [];
    const tally = await summariseFiles(deps, [file('bad.ts'), file('good.ts')], (event) => {
      if (event.kind === 'failed') failed.push(event.path);
    });

    expect(failed).toEqual(['bad.ts']);
    expect(tally).toMatchObject({ summarised: 1, failed: 1 });
  });

  it('is silent when the review was cancelled', async () => {
    deps.provider = stub(() => new ProviderError('cancelled', 'cancelled'));
    const events: unknown[] = [];
    const tally = await summariseFiles(deps, [file('a.ts')], (event) => events.push(event));

    expect(events).toEqual([]);
    expect(tally.failed).toBe(0);
  });
});
