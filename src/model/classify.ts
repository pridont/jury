import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Repo } from '../git/repo.js';
import type { FileChange } from '../git/parse.js';
import { checkAttributes } from '../git/attributes.js';
import { applyVerdicts, classifyAll, type ClassifyInput } from './noise.js';
import { probeWorkspace } from './workspace.js';

export type ClassifyOptions = {
  /** "off" skips classification entirely; everything stays in the reading order. */
  mode?: 'collapse' | 'inline' | 'off';
  patterns?: readonly string[];
  /** Paths the reviewer has said are not scaffolding, whatever the signals say. */
  overrides?: ReadonlySet<string>;
  /** True when the new side is the working tree, so headers can be read from disk. */
  fromDisk?: boolean;
};

/**
 * Decide what is generator output before anything else looks at the diff, so it stays out of
 * the reading order, out of the progress count, and later out of the token budget.
 */
export async function classifyScaffolding(
  repo: Repo,
  files: FileChange[],
  options: ClassifyOptions = {},
): Promise<void> {
  if (options.mode === 'off') {
    applyVerdicts(files, new Map());
    return;
  }

  const workspace = await probeWorkspace(repo.root);
  const attributes = await checkAttributes(
    repo,
    files.map((file) => file.path),
  );

  const inputs = new Map<string, ClassifyInput>();
  await Promise.all(
    files.map(async (file) => {
      inputs.set(file.path, {
        workspace,
        patterns: options.patterns ?? [],
        overrides: options.overrides ?? new Set<string>(),
        attributes: attributes.get(file.path) ?? new Set<string>(),
        header: await readHeader(repo, file, options.fromDisk ?? false),
      });
    }),
  );

  applyVerdicts(files, classifyAll(files, inputs));
}

/** The first bytes of the new side, which is where a generated-code marker lives. */
async function readHeader(repo: Repo, file: FileChange, fromDisk: boolean): Promise<string | null> {
  if (file.binary || file.status === 'deleted') return null;

  // The added lines of the first hunk are the cheapest look inside, and for a new file they
  // are the file. Only fall back to disk when the diff starts further down.
  const added = file.hunks[0]?.lines.filter((line) => line.startsWith('+')).slice(0, 20) ?? [];
  const fromDiff = added.map((line) => line.slice(1)).join('\n');
  if (file.status === 'added' && fromDiff) return fromDiff;
  if (!fromDisk) return fromDiff || null;

  try {
    const handle = await fs.open(path.join(repo.root, file.path), 'r');
    try {
      const buffer = Buffer.alloc(2048);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return fromDiff || null;
  }
}
