import type { FileChange } from '../git/parse.js';
import type { Hunk } from '../model/types.js';

/** How many changed lines of each hunk the model sees before detail starts being shed. */
const SAMPLE_LINES = 8;

export type Digest = {
  text: string;
  /** Label to hunk. The only place `h1` means anything. */
  labels: Map<string, Hunk>;
  /** Hunks kept out of the digest entirely, and out of the reading order. */
  scaffolding: Hunk[];
};

/**
 * The change set as the model sees it.
 *
 * Not the raw diff: per hunk, its label, file, symbol, size and a sample of its changed
 * lines, plus whatever pass 1 said about each file. A 3000-line diff digests to a few
 * thousand tokens.
 *
 * Detail is shed in the order the model can most afford to lose — samples shrink, then go —
 * but never the structure. **A hunk missing from the digest is a hunk the model cannot
 * place**, and an unplaced hunk is one the reviewer might never be shown.
 *
 * Labels are short (`h1`, `h2`) rather than content hashes: shorter to read, far shorter to
 * write back, and a label the model invents is obviously invalid rather than plausibly real.
 */
export function buildDigest(
  files: readonly FileChange[],
  summaries: ReadonlyMap<string, string>,
  budget: number,
): Digest {
  const labels = new Map<string, Hunk>();
  const scaffolding: Hunk[] = [];

  const reviewable: { file: FileChange; hunks: Hunk[] }[] = [];
  for (const file of files) {
    const own = file.hunks.filter((hunk) => hunk.scaffolding === undefined);
    scaffolding.push(...file.hunks.filter((hunk) => hunk.scaffolding !== undefined));
    if (own.length > 0) reviewable.push({ file, hunks: own });
  }

  let next = 1;
  for (const { hunks } of reviewable) {
    for (const hunk of hunks) labels.set(`h${next++}`, hunk);
  }
  const labelOf = new Map([...labels].map(([label, hunk]) => [hunk, label]));

  // Render at the fullest sample that fits, then progressively less. Structure is written
  // every time; only the samples give way.
  for (const sample of [SAMPLE_LINES, 4, 2, 0]) {
    const text = render(reviewable, summaries, labelOf, scaffolding, sample);
    if (text.length <= budget || sample === 0) {
      return { text, labels, scaffolding };
    }
  }

  /* c8 ignore next */
  return { text: render(reviewable, summaries, labelOf, scaffolding, 0), labels, scaffolding };
}

function render(
  reviewable: readonly { file: FileChange; hunks: Hunk[] }[],
  summaries: ReadonlyMap<string, string>,
  labelOf: ReadonlyMap<Hunk, string>,
  scaffolding: readonly Hunk[],
  sample: number,
): string {
  const hunkCount = reviewable.reduce((n, entry) => n + entry.hunks.length, 0);
  const lines: string[] = [
    `${reviewable.length} files, ${hunkCount} hunks.`,
    '',
  ];

  for (const { file, hunks } of reviewable) {
    lines.push(`## ${file.path}${file.status === 'modified' ? '' : ` (${file.status})`}`);
    const summary = summaries.get(file.path);
    if (summary) lines.push(summary);

    for (const hunk of hunks) {
      const parts = [
        labelOf.get(hunk) ?? '?',
        hunk.symbol ? `in ${hunk.symbol}` : '',
        `+${hunk.stats.added} -${hunk.stats.removed}`,
      ].filter(Boolean);
      lines.push(parts.join('  '));

      if (sample > 0) {
        const changed = hunk.lines.filter((line) => line.startsWith('+') || line.startsWith('-'));
        for (const line of changed.slice(0, sample)) lines.push(`    ${line}`);
        if (changed.length > sample) lines.push(`    … ${changed.length - sample} more changed lines`);
      }
    }
    lines.push('');
  }

  if (scaffolding.length > 0) {
    const reasons = [...new Set(scaffolding.map((hunk) => hunk.scaffolding?.reason).filter(Boolean))];
    // Named but not shown: the model should know they exist and not try to account for them.
    lines.push(
      `(${scaffolding.length} hunks were classified as generated and are not part of the review: ` +
        `${reasons.join(', ')}.)`,
    );
  }

  return lines.join('\n');
}
