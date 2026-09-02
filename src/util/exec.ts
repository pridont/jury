import { spawn } from 'node:child_process';

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

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
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

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr })));

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/** Run and reject unless the command exited 0. */
export async function runOk(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  const result = await run(command, args, options);
  if (result.code !== 0) throw new RunError(command, result);
  return result.stdout;
}

/** Whether an executable can be started at all. Cheap, and does not care what it prints. */
export async function isOnPath(command: string, versionArg = '--version'): Promise<boolean> {
  try {
    const result = await run(command, [versionArg], { timeoutMs: 5000 });
    return result.code === 0;
  } catch {
    return false;
  }
}
