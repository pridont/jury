import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkspaceHints } from './noise.js';

const MARKERS = ['nx.json', 'angular.json', 'workspace.json', 'turbo.json', 'pnpm-workspace.yaml'];

/**
 * Whether this repository is the kind that has generators.
 *
 * Only then does a `project.json` or a `jest.config.ts` mean "a tool wrote this"; in a plain
 * repository the same file was written by hand and is review material like anything else.
 */
export async function probeWorkspace(root: string): Promise<WorkspaceHints> {
  const found = await Promise.all(
    MARKERS.map(async (marker) => {
      try {
        await fs.access(path.join(root, marker));
        return true;
      } catch {
        return false;
      }
    }),
  );
  return { monorepo: found.some(Boolean) };
}
