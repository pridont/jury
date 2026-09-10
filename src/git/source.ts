import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { run, runOk } from '../util/exec.js';
import { mergeBase, type Repo } from './repo.js';
import { parseDiff, type FileChange } from './parse.js';
import type { ReviewSpec } from '../model/types.js';

/** git's hash of the empty tree — the base when a repository has no commits yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Above this, an untracked file is listed rather than shown. */
const MAX_UNTRACKED_BYTES = 512 * 1024;

export type Acquired = {
  /** Resolved revisions, recorded so the review can say what it compared. */
  base: string;
  head: string;
  files: FileChange[];
};

const DIFF_ARGS = [
  '-c',
  'core.quotePath=false',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--find-renames',
  '--find-copies',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

export async function acquire(repo: Repo, spec: ReviewSpec, contextLines = 3): Promise<Acquired> {
  const unified = [`-U${contextLines}`];

  switch (spec.kind) {
    case 'worktree': {
      const head = await headOrEmptyTree(repo);
      const text = await runOk('git', [...DIFF_ARGS, ...unified, head], { cwd: repo.root, timeoutMs: 60_000 });
      const files = parseDiff(text);
      files.push(...(await untrackedFiles(repo)));
      return { base: head, head: 'worktree', files };
    }

    case 'staged': {
      const head = await headOrEmptyTree(repo);
      const text = await runOk('git', [...DIFF_ARGS, ...unified, '--cached', head], {
        cwd: repo.root,
        timeoutMs: 60_000,
      });
      return { base: head, head: 'index', files: parseDiff(text) };
    }

    case 'range': {
      const head = await resolve(repo, spec.head);
      const base = spec.threeDot ? await mergeBase(repo, spec.base, spec.head) : await resolve(repo, spec.base);
      const text = await runOk('git', [...DIFF_ARGS, ...unified, base, head], {
        cwd: repo.root,
        timeoutMs: 60_000,
      });
      return { base, head, files: parseDiff(text) };
    }

    case 'pr': {
      // The head is already fetched into a ref of our own by the caller; nothing is checked
      // out, and both sides of the diff are read straight from git.
      const text = await runOk('git', [...DIFF_ARGS, ...unified, spec.base, spec.head], {
        cwd: repo.root,
        timeoutMs: 60_000,
      });
      return { base: spec.base, head: spec.head, files: parseDiff(text) };
    }
  }
}

async function resolve(repo: Repo, rev: string): Promise<string> {
  const out = await runOk('git', ['rev-parse', '--verify', `${rev}^{commit}`], {
    cwd: repo.root,
    timeoutMs: 10_000,
  });
  return out.trim();
}

async function headOrEmptyTree(repo: Repo): Promise<string> {
  const result = await run('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
    cwd: repo.root,
    timeoutMs: 10_000,
  });
  return result.code === 0 ? result.stdout.trim() : EMPTY_TREE;
}

/**
 * `git diff HEAD` cannot see a file git does not track, so a brand new file — usually the
 * thing most worth reading — would be invisible. Synthesise the added-file diff git would
 * have produced, so nothing downstream has to know this case exists.
 */
async function untrackedFiles(repo: Repo): Promise<FileChange[]> {
  const out = await runOk('git', ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: repo.root,
    timeoutMs: 30_000,
  });
  const paths = out.split('\0').filter((p) => p.length > 0);
  if (paths.length === 0) return [];

  const diffs = await Promise.all(paths.map((p) => synthesiseAdded(repo, p)));
  return parseDiff(diffs.filter((d) => d !== null).join(''));
}

async function synthesiseAdded(repo: Repo, relative: string): Promise<string | null> {
  const absolute = path.join(repo.root, relative);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    return null; // Deleted between listing and reading; not our problem to report.
  }
  if (!stat.isFile()) return null;

  const mode = stat.mode & 0o111 ? '100755' : '100644';
  const header = `diff --git a/${relative} b/${relative}\nnew file mode ${mode}\n`;

  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `${header}Binary files /dev/null and b/${relative} differ\n`;
  }

  // Read as bytes: reading as text turns NUL into U+FFFD and loses the one signal that
  // tells a binary file from a text one.
  const buffer = await fs.readFile(absolute);
  if (buffer.includes(0)) {
    return `${header}Binary files /dev/null and b/${relative} differ\n`;
  }
  if (buffer.length === 0) {
    return header;
  }

  const content = buffer.toString('utf8');
  const endsWithNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (endsWithNewline) lines.pop();

  const body = lines.map((line) => `+${line}`).join('\n');
  const trailer = endsWithNewline ? '\n' : '\n\\ No newline at end of file\n';

  return `${header}--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1,${lines.length} @@\n${body}${trailer}`;
}
