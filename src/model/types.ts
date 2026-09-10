/** What a review was asked for. State is keyed by this, never by resolved revisions. */
export type ReviewSpec =
  | { kind: 'worktree' }
  | { kind: 'staged' }
  | { kind: 'range'; base: string; head: string; threeDot: boolean }
  | { kind: 'pr'; number: number };

export function describeSpec(spec: ReviewSpec): string {
  switch (spec.kind) {
    case 'worktree':
      return 'working tree';
    case 'staged':
      return 'staged changes';
    case 'range':
      return `${spec.base}${spec.threeDot ? '...' : '..'}${spec.head}`;
    case 'pr':
      return `pull request #${spec.number}`;
  }
}

export type HunkKind = 'text' | 'binary' | 'rename' | 'mode' | 'empty';

export type Hunk = {
  /** sha256(path + NUL + normalised body), truncated. Content-based, never positional. */
  id: string;
  path: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Raw diff lines, including the leading +/-/space. */
  lines: string[];
  stats: { added: number; removed: number };
  kind: HunkKind;
  symbol?: string;
  /** Set when the classifier decided this is generator output; the reason is always shown. */
  scaffolding?: { reason: string };
};

export type Layer = {
  id: string;
  title: string;
  summary: string;
  hunkIds: string[];
  /** The files this layer touches. A layer routinely spans several; the title need not. */
  paths: string[];
};

export type CohortKind =
  | 'feature'
  | 'fix'
  | 'refactor'
  | 'plumbing'
  | 'test'
  | 'config'
  | 'docs'
  | 'generated'
  | 'scaffolding'
  /** The heuristic's honest default: a change whose intent no path can reveal. */
  | 'change'
  | 'unclassified';

export type Risk = 'low' | 'medium' | 'high';

export type Cohort = {
  id: string;
  title: string;
  summary: string;
  kind: CohortKind;
  risk: Risk;
  riskReason?: string;
  /** Array position is the reading order. */
  layers: Layer[];
  origin: 'ai' | 'heuristic';
};

export type Comment = {
  id: string;
  hunkId: string;
  /** Line offset within the hunk, so the note holds its place when code above it moves. */
  offset: number;
  side: 'old' | 'new';
  body: string;
  orphaned: boolean;
  moved: boolean;
  createdAt: number;
  github?: { reviewCommentId: number };
};

export type Review = {
  id: string;
  spec: ReviewSpec;
  base: string;
  head: string;
  hunks: Record<string, Hunk>;
  /** Array position is the reading order. */
  cohorts: Cohort[];
  comments: Comment[];
  marks: Record<string, 'reviewed'>;
  meta: { createdAt: number; updatedAt: number; promptVersion: number; schema: 1 };
};
