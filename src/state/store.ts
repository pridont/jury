import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stateDir, type Repo } from '../git/repo.js';
import { describeSpec, type Comment, type ReviewSpec } from '../model/types.js';

export const SCHEMA = 1;

export type StoredReview = {
  schema: number;
  id: string;
  repoRoot: string;
  spec: ReviewSpec;
  label: string;
  marks: string[];
  notScaffolding: string[];
  comments: Comment[];
  createdAt: number;
  updatedAt: number;
};

/**
 * A review is identified by what was asked for, never by the revisions that resolved to.
 *
 * `main...HEAD` has to survive main moving on. Keying by resolved SHAs would mean every push
 * silently started a new review and threw the reviewer's progress away.
 */
export function reviewId(repo: Repo, spec: ReviewSpec): string {
  return createHash('sha1').update(`${repo.root}\0${JSON.stringify(identity(spec))}`).digest('hex').slice(0, 16);
}

/**
 * The part of a spec that identifies it.
 *
 * A commit's subject rides along for the label, but the same commit opened from the graph
 * and from the palette has to be one review — not two whose progress depends on the way in.
 */
function identity(spec: ReviewSpec): ReviewSpec | { kind: 'commit'; sha: string } | { kind: 'pr'; number: number } {
  if (spec.kind === 'commit') return { kind: 'commit', sha: spec.sha };
  // A pull request is the same review after every push, and after its title is edited.
  if (spec.kind === 'pr') return { kind: 'pr', number: spec.number };
  return spec;
}

/**
 * The id a pull request review was saved under before its identity was only its number.
 * Found when opened the same way again — reload, resume, or the saved list — and carried over.
 */
export function legacyReviewId(repo: Repo, spec: ReviewSpec): string | null {
  if (spec.kind !== 'pr') return null;
  return createHash('sha1').update(`${repo.root}\0${JSON.stringify(spec)}`).digest('hex').slice(0, 16);
}

/** Forget a saved review. */
export async function remove(repo: Repo, id: string): Promise<void> {
  await fs.rm(fileFor(repo, id), { force: true });
}

function fileFor(repo: Repo, id: string): string {
  return path.join(stateDir(repo), `${id}.json`);
}

export async function load(repo: Repo, id: string): Promise<StoredReview | null> {
  const file = fileFor(repo, id);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as StoredReview;
    // A file from a future schema is not ours to interpret; starting fresh loses progress,
    // guessing at it loses trust.
    if (parsed.schema === SCHEMA) return parsed;
  } catch {
    // Unreadable. Handled below with the future schema.
  }

  // Moved aside rather than left where the next save would overwrite it with an empty review:
  // the notes in it are still there for someone to recover by hand.
  await fs.rename(file, `${file}.unreadable-${Date.now()}`).catch(() => undefined);
  return null;
}

/**
 * Write the review state atomically — temp file, then rename — so a crash mid-write leaves
 * the previous state intact rather than a truncated one.
 *
 * State lives inside `.git`, so it is never committed and never dirties the working tree,
 * and it uses the common git dir so every worktree of the repository shares it.
 */
export function save(repo: Repo, review: StoredReview): Promise<void> {
  const target = fileFor(repo, review.id);
  // One write at a time per file. Two overlapping writes share the temp file, interleave in
  // it, and the rename installs the mix — which the next load cannot parse.
  const next = (writing.get(target) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => write(repo, target, review));
  writing.set(target, next);
  return next;
}

const writing = new Map<string, Promise<void>>();

async function write(repo: Repo, target: string, review: StoredReview): Promise<void> {
  await fs.mkdir(stateDir(repo), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ ...review, updatedAt: Date.now() }, null, 2));
  await fs.rename(temporary, target);
}

/** Every saved review for this repository, most recently touched first. */
export async function list(repo: Repo): Promise<StoredReview[]> {
  let names: string[];
  try {
    names = await fs.readdir(stateDir(repo));
  } catch {
    return [];
  }

  const reviews = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) => load(repo, name.slice(0, -'.json'.length))),
  );

  return reviews
    .filter((review): review is StoredReview => review !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function emptyReview(repo: Repo, spec: ReviewSpec): StoredReview {
  const now = Date.now();
  return {
    schema: SCHEMA,
    id: reviewId(repo, spec),
    repoRoot: repo.root,
    spec,
    label: describeSpec(spec),
    marks: [],
    notScaffolding: [],
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
}
