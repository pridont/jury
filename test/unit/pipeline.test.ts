import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../../src/util/exec.js';
import { findRepo, type Repo } from '../../src/git/repo.js';
import { acquire } from '../../src/git/source.js';
import { classifyScaffolding } from '../../src/model/classify.js';
import { heuristicCohorts } from '../../src/model/heuristic.js';
import { buildOrder } from '../../src/model/order.js';

let dir: string;
let repo: Repo;

const git = (...args: string[]) => run('git', args, { cwd: dir });
const write = async (rel: string, body: string) => {
  await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), body);
};
const commit = async (message: string) => {
  await git('add', '-A');
  await git('commit', '-q', '-m', message);
};

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'changestack-pipeline-')));
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  repo = (await findRepo(dir))!;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** The file set an Nx library generator actually writes, plus a real change beside it. */
async function nxGeneratorRun(): Promise<void> {
  await write('nx.json', JSON.stringify({ npmScope: 'acme', targetDefaults: {} }, null, 2) + '\n');
  await write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }, null, 2) + '\n');
  await write('pnpm-lock.yaml', 'lockfileVersion: 6.0\n');
  await write('apps/web/src/auth.ts', 'export function check(now: number) {\n  return now < 10;\n}\n');
  await commit('base');

  // The change worth reading.
  await write('apps/web/src/auth.ts', 'export function check(now: number) {\n  return now <= 10;\n}\n');
  await write('apps/web/src/auth.spec.ts', "import { check } from './auth';\n\nit('accepts exactly now', () => {\n  expect(check(10)).toBe(true);\n});\n");

  // Everything the generator wrote.
  await write('libs/tokens/project.json', JSON.stringify({ name: 'tokens', sourceRoot: 'libs/tokens/src' }, null, 2) + '\n');
  await write('libs/tokens/tsconfig.json', '{ "extends": "../../tsconfig.base.json" }\n');
  await write('libs/tokens/tsconfig.lib.json', '{ "extends": "./tsconfig.json" }\n');
  await write('libs/tokens/jest.config.ts', "export default { displayName: 'tokens' };\n");
  await write('libs/tokens/.eslintrc.json', '{ "extends": ["../../.eslintrc.json"] }\n');
  // Two READMEs, to pin the distinction: one is the title a generator leaves behind, the
  // other is a person explaining something.
  await write('libs/tokens/README.md', '# tokens\n\n**Type:** util\n\n## Tags\n\ntype:util, scope:shared\n');
  await write(
    'libs/tokens/USAGE.md',
    '# Using tokens\n\nImport from the barrel, never from lib: the deep path is not part of the public API.\n',
  );
  await write('libs/tokens/src/index.ts', "export * from './lib/tokens';\n");
  await write('libs/tokens/src/lib/tokens.ts', 'export const TOKENS = 1;\n');

  // The registry edits the generator makes on the way.
  await write('nx.json', JSON.stringify({ npmScope: 'acme', targetDefaults: {}, tokens: {} }, null, 2) + '\n');
  await write('pnpm-lock.yaml', 'lockfileVersion: 6.0\npackages:\n  tokens: 1\n');
}

describe('a generator run does not bury the change', () => {
  it('collapses the generator output and opens on the code', async () => {
    await nxGeneratorRun();

    const acquired = await acquire(repo, { kind: 'worktree' });
    await classifyScaffolding(repo, acquired.files, { fromDisk: true });
    const cohorts = heuristicCohorts(acquired.files);
    const order = buildOrder(cohorts, acquired.files);

    const scaffolded = acquired.files.filter((f) => f.hunks.some((h) => h.scaffolding)).map((f) => f.path).sort();

    // Precision is the number that matters: nothing hand-written may be hidden.
    expect(scaffolded).not.toContain('apps/web/src/auth.ts');
    expect(scaffolded).not.toContain('apps/web/src/auth.spec.ts');
    expect(scaffolded).not.toContain('libs/tokens/src/index.ts');
    expect(scaffolded).not.toContain('libs/tokens/src/lib/tokens.ts');
    // A README that is a heading and a tag table has nothing in it to read.
    expect(scaffolded).toContain('libs/tokens/README.md');
    // One with a sentence in it is documentation, and stays.
    expect(scaffolded).not.toContain('libs/tokens/USAGE.md');

    // Recall: the config noise and the lockfile are out of the way.
    expect(scaffolded).toContain('libs/tokens/project.json');
    expect(scaffolded).toContain('libs/tokens/jest.config.ts');
    expect(scaffolded).toContain('libs/tokens/.eslintrc.json');
    expect(scaffolded).toContain('libs/tokens/tsconfig.json');
    expect(scaffolded).toContain('pnpm-lock.yaml');
    expect(scaffolded).toContain('nx.json');

    // One trailing cohort, labelled, holding all of it.
    const last = cohorts[cohorts.length - 1]!;
    expect(last.kind).toBe('scaffolding');
    expect(last.title).toBe(`Scaffolding · ${scaffolded.length} files`);
    expect(cohorts.filter((c) => c.kind === 'scaffolding')).toHaveLength(1);

    // The review opens on the behaviour change, with its test in the same cohort behind it.
    expect(order[0]!.file.path).toBe('apps/web/src/auth.ts');
    expect(order[0]!.cohort.layers.map((l) => l.title)).toEqual([
      'apps/web/src/auth.ts',
      'apps/web/src/auth.spec.ts',
    ]);

    // And the generator's output is not what a person is measured against.
    const readable = order.filter((e) => !e.scaffolding).length;
    expect(readable).toBeLessThan(order.length);
  });

  it('respects .gitattributes over every path heuristic', async () => {
    await write('.gitattributes', 'src/api.ts linguist-generated=true\n');
    await write('src/api.ts', 'export const a = 1;\n');
    await commit('base');
    await write('src/api.ts', 'export const a = 2;\n');

    const acquired = await acquire(repo, { kind: 'worktree' });
    await classifyScaffolding(repo, acquired.files, { fromDisk: true });

    const api = acquired.files.find((f) => f.path === 'src/api.ts')!;
    expect(api.hunks[0]!.scaffolding).toEqual({ reason: 'marked linguist-generated' });
  });

  it('leaves everything in the reading order when classification is off', async () => {
    await nxGeneratorRun();

    const acquired = await acquire(repo, { kind: 'worktree' });
    await classifyScaffolding(repo, acquired.files, { mode: 'off', fromDisk: true });
    const order = buildOrder(heuristicCohorts(acquired.files), acquired.files);

    expect(order.every((e) => !e.scaffolding)).toBe(true);
  });

  it('lets a reviewer take a file back', async () => {
    await nxGeneratorRun();

    const acquired = await acquire(repo, { kind: 'worktree' });
    await classifyScaffolding(repo, acquired.files, {
      fromDisk: true,
      overrides: new Set(['libs/tokens/project.json']),
    });

    const project = acquired.files.find((f) => f.path === 'libs/tokens/project.json')!;
    expect(project.hunks[0]!.scaffolding).toBeUndefined();
  });
});
