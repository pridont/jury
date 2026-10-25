import * as vscode from 'vscode';
import type { Session } from '../session.js';
import { describeSpec } from '../model/types.js';
import type { Documents } from './documents.js';

/** The extension that teaches an older VS Code's markdown preview to draw mermaid. */
const MERMAID_EXTENSION = 'bierner.markdown-mermaid';

/**
 * Anything that makes the markdown preview draw mermaid. Newer VS Code ships its own, and a
 * reviewer who has it should get the picture, not advice to install what they do not need.
 */
const MERMAID_RENDERERS = ['vscode.mermaid-markdown-features', MERMAID_EXTENSION];

/**
 * What this change is, before any of it.
 *
 * Not an outline of the tree — the tree is right there, and saying the same thing twice in a
 * worse medium wastes the one moment a reviewer is willing to read prose. This answers the
 * question the tree cannot: what does the software do now that it did not, and in what order
 * does the argument for it make sense.
 */
export async function showWalkthrough(session: Session, documents: Documents): Promise<void> {
  await documents.show('Walkthrough.md', render(session));
  await vscode.commands.executeCommand('markdown.showPreview');
}

export function render(session: Session, canDrawMermaid = hasMermaid()): string {
  const cohorts = session.cohorts.filter((cohort) => cohort.kind !== 'scaffolding');
  const scaffolding = session.cohorts.find((cohort) => cohort.kind === 'scaffolding');
  const hunks = session.files.flatMap((file) => file.hunks).filter((hunk) => !hunk.scaffolding).length;

  const lines: string[] = [
    `# ${describeSpec(session.spec)}`,
    '',
    (session.spec.kind === 'trail'
      ? `${cohorts.length} step${cohorts.length === 1 ? '' : 's'} · ${hunks} span${hunks === 1 ? '' : 's'} · `
      : `${cohorts.length} change${cohorts.length === 1 ? '' : 's'} · ${hunks} hunk${hunks === 1 ? '' : 's'} · `) +
      `${session.files.length} file${session.files.length === 1 ? '' : 's'}`,
    '',
  ];

  if (session.overview) {
    lines.push(session.overview, '');
  } else {
    lines.push(
      '_Grouped by file, in the order git produced them — no model has organised this._',
      '',
    );
  }

  if (session.diagram) {
    if (canDrawMermaid) {
      lines.push('```mermaid', session.diagram, '```', '');
    } else {
      lines.push(
        `_A diagram of this change is available, but nothing here can draw it. ` +
          `Install [Markdown Preview Mermaid Support](command:workbench.extensions.search?%22${MERMAID_EXTENSION}%22) ` +
          `and reopen this._`,
        '',
      );
    }
  }

  lines.push('## Read in this order', '');
  cohorts.forEach((cohort, index) => {
    const risk = cohort.risk === 'low' ? '' : ` **(${cohort.risk} risk)**`;
    // An area of a tour has no account of its own; its stops do, so they speak for it.
    if (!cohort.summary && cohort.layers.length > 1) {
      lines.push(`${index + 1}. **${cohort.title}**${risk}`);
      for (const layer of cohort.layers) lines.push(`   - **${layer.title}** — ${layer.summary || 'no summary'}`);
    } else {
      lines.push(`${index + 1}. **${cohort.title}**${risk} — ${cohort.summary || 'no summary'}`);
    }
    // Paragraphs of the item, after a blank line: an indented line straight after the item
    // is a continuation of its last sentence, and renders run into it.
    if (cohort.riskReason) lines.push('', `   ${cohort.riskReason}`);
    if (cohort.mismatch) lines.push('', `   **Not as described:** ${cohort.mismatch}`);
  });
  lines.push('');

  if (session.notes.length > 0) {
    lines.push('## Worth your attention', '');
    for (const note of session.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  if (scaffolding) {
    const files = scaffolding.layers.length;
    lines.push(`_${files} generated ${files === 1 ? 'file is' : 'files are'} not part of the review._`, '');
  }

  return lines.join('\n');
}

function hasMermaid(): boolean {
  return MERMAID_RENDERERS.some((id) => vscode.extensions.getExtension(id) !== undefined);
}
