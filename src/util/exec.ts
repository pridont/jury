import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Every child this module has running.
 *
 * A spawned process outlives its parent on POSIX — measured, not assumed — so if the
 * extension host goes away without disposing anything, a model call keeps running against
 * the user's account with nobody left to read the answer. It would finish its request and
 * exit on its own, but finishing a request nobody wants is exactly what cancellation is
 * for.
 */
const live = new Set<ChildProcess>();

/** Signal every running child. The backstop for a shutdown that skipped disposal. */
export function killAll(): void {
  for (const child of live) child.kill('SIGTERM');
  live.clear();
}

/** Kill children when the extension host exits, and stop listening when we are unloaded. */
export function guardAgainstOrphans(): { dispose: () => void } {
  const onExit = () => killAll();
  process.once('exit', onExit);
  process.once('SIGTERM', onExit);
  process.once('SIGINT', onExit);
  return {
    dispose: () => {
      process.removeListener('exit', onExit);
      process.removeListener('SIGTERM', onExit);
      process.removeListener('SIGINT', onExit);
      killAll();
    },
  };
}

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export class RunError extends Error {
  constructor(
    readonly command: string,
    readonly result: RunResult,
  ) {
    super(`${command} exited ${result.code}: ${result.stderr.trim() || '(no stderr)'}`);
    this.name = 'RunError';
  }
}

export type RunOptions = {
  cwd?: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Hand each non-blank line of stdout over as it arrives instead of buffering it, for a
   * stream that has to reach the reader while it is still being written. `stdout` then
   * comes back empty.
   */
  onLine?: (line: string) => void;
};

/**
 * Spawn a command and collect its output. Never blocks the extension host, never
 * uses a shell, so nothing in a path or a branch name can be interpreted as syntax.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: false,
    });
    live.add(child);

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      live.delete(child);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          finish(() => reject(new Error(`${command} timed out after ${options.timeoutMs}ms`)));
        }, options.timeoutMs)
      : (undefined as unknown as NodeJS.Timeout);

    const onAbort = () => {
      child.kill('SIGTERM');
      finish(() => reject(new Error(`${command} cancelled`)));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const { onLine } = options;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!onLine) return;
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    });
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => {
      if (onLine && stdout.trim()) onLine(stdout);
      finish(() => resolve({ code: code ?? -1, stdout: onLine ? '' : stdout, stderr }));
    });

    // A child that exits before reading its input breaks the pipe. Its exit code and stderr
    // already say what went wrong; unhandled, the EPIPE would take the extension host with it.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin);
  });
}

/** Run and reject unless the command exited 0. */
export async function runOk(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) throw new RunError(command, result);
  return result.stdout;
}

/** Whether an executable can be started at all. Cheap, and does not care what it prints. */
export async function isOnPath(command: string): Promise<boolean> {
  try {
    const result = await run(command, ['--version'], { timeoutMs: 5000 });
    return result.code === 0;
  } catch {
    return false;
  }
}
