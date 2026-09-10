import { describe, expect, it } from 'vitest';
import { run, runOk, isOnPath, killAll, RunError } from '../../src/util/exec.js';

describe('run', () => {
  it('collects stdout and the exit code', async () => {
    const result = await run('node', ['-e', 'process.stdout.write("hi")']);
    expect(result).toMatchObject({ code: 0, stdout: 'hi' });
  });

  it('reports a non-zero exit rather than throwing', async () => {
    const result = await run('node', ['-e', 'process.exit(3)']);
    expect(result.code).toBe(3);
  });

  it('passes stdin through', async () => {
    const result = await run(
      'node',
      ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))'],
      { stdin: 'prompt' },
    );
    expect(result.stdout).toBe('PROMPT');
  });

  it('does not go through a shell, so metacharacters stay literal', async () => {
    const result = await run('node', ['-e', 'process.stdout.write(process.argv[1])', 'a; rm -rf b']);
    expect(result.stdout).toBe('a; rm -rf b');
  });

  it('times out', async () => {
    await expect(run('node', ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });

  it('cancels on an abort signal', async () => {
    const controller = new AbortController();
    const promise = run('node', ['-e', 'setTimeout(()=>{},5000)'], { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(/cancelled/);
  });
});

describe('killAll', () => {
  it('signals a running child, so a shutdown that skipped disposal leaves nothing behind', async () => {
    const running = run('node', ['-e', 'setTimeout(()=>{}, 30000)']);
    // Let it actually start before pulling the rug.
    await new Promise((resolve) => setTimeout(resolve, 50));
    killAll();

    const result = await running;
    expect(result.code).not.toBe(0);
  });

  it('is harmless when nothing is running', () => {
    expect(() => killAll()).not.toThrow();
  });

  it('forgets a child that already finished', async () => {
    await run('node', ['-e', '0']);
    expect(() => killAll()).not.toThrow();
  });
});

describe('runOk', () => {
  it('throws a RunError carrying stderr', async () => {
    await expect(runOk('node', ['-e', 'console.error("boom");process.exit(1)'])).rejects.toBeInstanceOf(RunError);
  });
});

describe('isOnPath', () => {
  it('is true for a real executable and false for a missing one', async () => {
    expect(await isOnPath('git')).toBe(true);
    expect(await isOnPath('definitely-not-a-real-binary-xyz')).toBe(false);
  });
});
