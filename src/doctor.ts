import { run } from './util/exec.js';
import { findRepo } from './git/repo.js';
import { all } from './agent/provider.js';

export type Check = {
  name: string;
  ok: boolean;
  detail: string;
  /** False when the check failing only costs quality, not availability. */
  required: boolean;
};

async function version(command: string, args: string[]): Promise<string | null> {
  try {
    const result = await run(command, args, { timeoutMs: 5000 });
    return result.code === 0 ? result.stdout.trim().split('\n')[0] ?? '' : null;
  } catch {
    return null;
  }
}

async function checkGit(): Promise<Check> {
  const v = await version('git', ['--version']);
  return {
    name: 'git',
    ok: v !== null,
    detail: v ?? 'not found on PATH',
    required: true,
  };
}

async function checkRepo(cwd: string | undefined): Promise<Check> {
  if (!cwd) {
    return { name: 'repository', ok: false, detail: 'no folder open', required: true };
  }
  const repo = await findRepo(cwd);
  return {
    name: 'repository',
    ok: repo !== null,
    detail: repo
      ? `${repo.root}${repo.linkedWorktree ? ' (linked worktree)' : ''}`
      : `${cwd} is not inside a git repository`,
    required: true,
  };
}

async function checkGh(): Promise<Check> {
  const v = await version('gh', ['--version']);
  if (v === null) {
    return { name: 'gh', ok: false, detail: 'not found on PATH — pull request review unavailable', required: false };
  }
  const auth = await run('gh', ['auth', 'status'], { timeoutMs: 8000 }).catch(() => null);
  const signedIn = auth?.code === 0;
  return {
    name: 'gh',
    ok: signedIn,
    detail: signedIn ? `${v}, signed in` : `${v}, not signed in — run \`gh auth login\``,
    required: false,
  };
}

async function checkClaude(): Promise<Check> {
  const v = await version('claude', ['--version']);
  if (v === null) {
    return {
      name: 'claude',
      ok: false,
      detail: 'not found on PATH — the review works, grouped by file, with no summaries',
      required: false,
    };
  }
  // Sign-in is not probed here: the only honest probe is a real model call, and a
  // diagnostic command should not spend the user's tokens. The first pass reports it.
  return { name: 'claude', ok: true, detail: `${v} (sign-in verified on first call)`, required: false };
}

/** What each registered provider can do, so an unavailable one is a fact, not a silence. */
async function checkProviders(): Promise<Check[]> {
  return Promise.all(
    all().map(async (provider) => {
      const { ok, reason } = await provider.available();
      const can = provider.capabilities();
      const models = Object.entries(can.models)
        .map(([tier, model]) => `${tier}=${model}`)
        .join(' ');
      return {
        name: `provider ${provider.id}`,
        ok,
        detail: ok ? `${models}${can.repoTools ? ' · repo tools' : ''}` : (reason ?? 'unavailable'),
        required: false,
      };
    }),
  );
}

export async function doctor(cwd: string | undefined): Promise<Check[]> {
  const core = await Promise.all([checkGit(), checkRepo(cwd), checkGh(), checkClaude()]);
  return [...core, ...(await checkProviders())];
}

export function formatChecks(checks: Check[]): string {
  const lines = checks.map((c) => {
    const mark = c.ok ? '✓' : c.required ? '✗' : '·';
    return `${mark} ${c.name.padEnd(18)} ${c.detail}`;
  });
  return lines.join('\n');
}
