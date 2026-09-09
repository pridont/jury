import type { FileChange } from './git/parse.js';
import type { Cohort, Comment, Hunk, ReviewSpec } from './model/types.js';
import { describeSpec } from './model/types.js';
import { commentLine } from './model/comments.js';

export type ExportInput = {
  spec: ReviewSpec;
  base: string;
  head: string;
  cohorts: readonly Cohort[];
  files: readonly FileChange[];
  comments: readonly Comment[];
  marks: ReadonlySet<string>;
};

/**
 * The review as markdown, in the order it was read.
 *
 * Grouped by cohort rather than by file, because the grouping is the review: a list of notes
 * sorted by path is what the reviewer already had. Every note carries a `file:line` a
 * colleague can jump to, and a note the tool is only guessing the position of says so.
 */
export function toMarkdown(input: ExportInput): string {
  const hunks = new Map<string, Hunk>();
  for (const file of input.files) {
    for (const hunk of file.hunks) hunks.set(hunk.id, hunk);
  }

  const byHunk = new Map<string, Comment[]>();
  for (const comment of input.comments) {
    if (comment.orphaned) continue;
    const list = byHunk.get(comment.hunkId) ?? [];
    list.push(comment);
    byHunk.set(comment.hunkId, list);
  }

  const lines: string[] = [];
  const reviewable = [...hunks.values()].filter((hunk) => !hunk.scaffolding);
  const reviewed = reviewable.filter((hunk) => input.marks.has(hunk.id)).length;

  lines.push(`# Review — ${describeSpec(input.spec)}`);
  lines.push('');
  lines.push(
    `${input.files.length} files · ${reviewable.length} hunks · ${reviewed} reviewed · ` +
      `${input.comments.filter((c) => !c.orphaned).length} comments`,
  );
  lines.push('');
  lines.push(`\`${short(input.base)}\` → \`${short(input.head)}\``);
  lines.push('');

  for (const [index, cohort] of input.cohorts.entries()) {
    if (cohort.kind === 'scaffolding') continue;

    lines.push(`## ${index + 1}. ${cohort.title}`);
    lines.push('');
    if (cohort.summary) {
      lines.push(cohort.summary);
      lines.push('');
    }
    if (cohort.risk !== 'low') {
      lines.push(`**Risk: ${cohort.risk}**${cohort.riskReason ? ` — ${cohort.riskReason}` : ''}`);
      lines.push('');
    }

    for (const layer of cohort.layers) {
      const notes = layer.hunkIds.flatMap((id) => byHunk.get(id) ?? []);
      if (notes.length === 0) continue;

      lines.push(`### ${layer.title}`);
      lines.push('');
      for (const comment of notes) {
        const hunk = hunks.get(comment.hunkId);
        const where = hunk ? `${hunk.path}:${commentLine(hunk, comment)}` : comment.hunkId;
        lines.push(`- **${where}**${comment.moved ? ' _(position is approximate)_' : ''}`);
        for (const line of comment.body.trim().split('\n')) {
          lines.push(`  ${line}`);
        }
        lines.push('');
      }
    }
  }

  const orphaned = input.comments.filter((comment) => comment.orphaned);
  if (orphaned.length > 0) {
    lines.push('## Comments whose code is gone');
    lines.push('');
    for (const comment of orphaned) {
      lines.push(`- ${comment.body.trim().split('\n').join(' ')}`);
    }
    lines.push('');
  }

  const scaffolding = input.cohorts.find((cohort) => cohort.kind === 'scaffolding');
  if (scaffolding) {
    lines.push(`_${scaffolding.layers.length} generated files were not reviewed: ${scaffolding.summary}_`);
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function short(rev: string): string {
  return /^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 12) : rev;
}
