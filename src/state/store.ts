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
function identity(spec: ReviewSpec): ReviewSpec | { kind: 'commit'; sha: string } {
  return spec.kind === 'commit' ? { kind: 'commit', sha: spec.sha } : spec;
}

function fileFor(repo: Repo, id: string): string {
  return path.join(stateDir(repo), `${id}.json`);
}

export async function load(repo: Repo, id: string): Promise<StoredReview | null> {
  try {
    const text = await fs.readFile(fileFor(repo, id), 'utf8');
    const parsed = JSON.parse(text) as StoredReview;
    // A file from a future schema is not ours to interpret; starting fresh loses progress,
    // guessing at it loses trust.
    if (parsed.schema !== SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write the review state atomically — temp file, then rename — so a crash mid-write leaves
 * the previous state intact rather than a truncated one.
 *
 * State lives inside `.git`, so it is never committed and never dirties the working tree,
 * and it uses the common git dir so every worktree of the repository shares it.
 */
export async function save(repo: Repo, review: StoredReview): Promise<void> {
  const dir = stateDir(repo);
  await fs.mkdir(dir, { recursive: true });

  const target = fileFor(repo, review.id);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ ...review, updatedAt: Date.now() }, null, 2));
  await fs.rename(temporary, target);
}

export async function remove(repo: Repo, id: string): Promise<void> {
  await fs.rm(fileFor(repo, id), { force: true });
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
