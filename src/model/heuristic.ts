import type { FileChange } from '../git/parse.js';
import type { Cohort, CohortKind, Hunk, Layer } from './types.js';

/**
 * Group a diff without a model.
 *
 * This is the baseline that always exists — with AI off, with no provider installed, or
 * before clustering has answered — and it is the number clustering has to beat to be worth
 * anything. It groups by file, pairs a test with the source it tests, and orders by what
 * kind of file each is. It does not pretend to know intent: cohorts it invents are `change`,
 * not `fix` or `refactor`, because guessing that from a path is how a tool starts lying.
 */
export function heuristicCohorts(files: FileChange[]): Cohort[] {
  const withHunks = files.filter((file) => file.hunks.length > 0);
  const scaffolding = withHunks.filter(isScaffolding);
  const rest = withHunks.filter((file) => !isScaffolding(file));

  const paired = pairTestsWithSources(rest);
  const cohorts = paired.map(toCohort);

  cohorts.sort((a, b) => rank(a.kind) - rank(b.kind) || a.title.localeCompare(b.title));

  if (scaffolding.length > 0) {
    cohorts.push(scaffoldingCohort(scaffolding));
  }
  return cohorts;
}

type Group = { files: FileChange[]; kind: CohortKind };

/**
 * A test and the code it tests are one piece of work, and the source is read first: a
 * reviewer cannot judge an assertion before they know what it is asserting about.
 */
function pairTestsWithSources(files: FileChange[]): Group[] {
  const sources = new Map<string, FileChange>();
  // A test rarely sits beside its source: `tests/cache_spec.lua` tests
  // `lua/revstack/agent/cache.lua`. Matching the basename finds those, but only when it is
  // unambiguous — half a codebase is called `index`, and a wrong pairing reads as a lie
  // about what belongs together.
  const byBasename = new Map<string, FileChange | null>();

  for (const file of files) {
    if (isTest(file.path)) continue;
    const full = stem(file.path);
    sources.set(full, file);
    const base = basename(full);
    byBasename.set(base, byBasename.has(base) ? null : file);
  }

  const groups: Group[] = [];
  const taken = new Set<FileChange>();

  for (const file of files) {
    if (taken.has(file) || isTest(file.path)) continue;
    const group: Group = { files: [file], kind: kindOf(file) };
    taken.add(file);
    groups.push(group);
  }

  for (const file of files) {
    if (taken.has(file)) continue;
    const testStem = stem(file.path);
    const source = sources.get(testStem) ?? byBasename.get(basename(testStem)) ?? undefined;
    const group = source ? groups.find((g) => g.files[0] === source) : undefined;
    if (group) group.files.push(file);
    else groups.push({ files: [file], kind: 'test' });
    taken.add(file);
  }

  return groups;
}

function toCohort(group: Group): Cohort {
  const layers: Layer[] = group.files.map((file) => ({
    id: `l:${file.path}`,
    title: file.path,
    summary: describe(file),
    hunkIds: file.hunks.map((hunk) => hunk.id),
  }));

  const lead = group.files[0]!;
  const extra = group.files.length - 1;

  return {
    id: `h:${lead.path}`,
    title: extra > 0 ? `${lead.path} and its test${extra > 1 ? 's' : ''}` : lead.path,
    summary: group.files.map(describe).join(' '),
    kind: group.kind,
    risk: 'low',
    layers,
    origin: 'heuristic',
  };
}

function scaffoldingCohort(files: FileChange[]): Cohort {
  const reasons = new Set<string>();
  for (const file of files) {
    const reason = file.hunks[0]?.scaffolding?.reason;
    if (reason) reasons.add(reason);
  }
  return {
    id: 'h:scaffolding',
    title: `Scaffolding · ${files.length} file${files.length === 1 ? '' : 's'}`,
    summary: `Generated or vendored: ${[...reasons].join(', ')}. Not in the reading order.`,
    kind: 'scaffolding',
    risk: 'low',
    layers: files.map((file) => ({
      id: `l:${file.path}`,
      title: file.path,
      summary: file.hunks[0]?.scaffolding?.reason ?? 'generated',
      hunkIds: file.hunks.map((hunk) => hunk.id),
    })),
    origin: 'heuristic',
  };
}

function describe(file: FileChange): string {
  if (file.binary) return `${file.path} (binary, ${file.status}).`;
  if (file.status === 'renamed') return `${file.oldPath} moved to ${file.path}.`;
  return `${file.path} ${file.status}, +${file.stats.added} −${file.stats.removed}.`;
}

const ORDER: CohortKind[] = [
  'feature',
  'fix',
  'refactor',
  'change',
  'plumbing',
  'config',
  'test',
  'docs',
  'generated',
  'unclassified',
  'scaffolding',
];

function rank(kind: CohortKind): number {
  const at = ORDER.indexOf(kind);
  return at === -1 ? ORDER.length : at;
}

export function kindOf(file: FileChange): CohortKind {
  const path = file.path;
  if (isScaffolding(file)) return 'scaffolding';
  if (isTest(path)) return 'test';
  if (isDocs(path)) return 'docs';
  if (isConfig(path)) return 'config';
  return 'change';
}

const TEST_PATH = /(^|\/)(tests?|spec|__tests__)\//i;
const TEST_NAME = /(\.|_|-)(test|spec)\.[^./]+$|(^|\/)test_[^/]*\.py$|_test\.go$|Test\.(java|kt|cs)$/;

export function isTest(path: string): boolean {
  return TEST_PATH.test(path) || TEST_NAME.test(path);
}

function isDocs(path: string): boolean {
  return /\.(md|mdx|rst|adoc|txt)$/i.test(path) || /(^|\/)(docs?|documentation)\//i.test(path) || /(^|\/)LICENSE$/.test(path);
}

function isConfig(path: string): boolean {
  return (
    /\.(json|ya?ml|toml|ini|cfg|conf)$/i.test(path) ||
    /(^|\/)\.[^/]+rc$/.test(path) ||
    /(^|\/)(Dockerfile|Makefile)$/.test(path)
  );
}

function isScaffolding(file: FileChange): boolean {
  return file.hunks.some((hunk: Hunk) => hunk.scaffolding !== undefined);
}

function basename(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(at + 1);
}

/** `src/auth/token.spec.ts` -> `src/auth/token`, so a test can find its source. */
export function stem(path: string): string {
  let out = path.replace(/\.[^./]+$/, '');
  out = out.replace(/(\.|_|-)(test|spec)$/i, '');
  out = out.replace(/^test_/, '');
  out = out.replace(/_test$/, '');
  out = out.replace(/Test$/, '');
  // A test mirrored under tests/ or __tests__/ still points at the same stem.
  out = out.replace(/(^|\/)(tests?|spec|__tests__)\//i, '$1');
  return out;
}
