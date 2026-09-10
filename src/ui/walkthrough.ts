import * as vscode from 'vscode';
import type { Session } from '../session.js';
import { describeSpec } from '../model/types.js';

/**
 * What the change set is, before any code.
 *
 * A markdown document rather than a webview: it renders diagrams and links, opens beside the
 * review, and there is nothing to maintain. This is the thing to read first, and the reason
 * the ordering exists — the stack without the walkthrough is a list.
 */
export async function showWalkthrough(session: Session): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    content: render(session),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  await vscode.commands.executeCommand('markdown.showPreview');
}

export function render(session: Session): string {
  const reviewable = session.files.flatMap((file) => file.hunks).filter((hunk) => !hunk.scaffolding);
  const cohorts = session.cohorts.filter((cohort) => cohort.kind !== 'scaffolding');
  const scaffolding = session.cohorts.find((cohort) => cohort.kind === 'scaffolding');

  const lines: string[] = [
    `# ${describeSpec(session.spec)} — ${cohorts.length} change${cohorts.length === 1 ? '' : 's'}, ` +
      `${reviewable.length} hunk${reviewable.length === 1 ? '' : 's'}, ${session.files.length} files`,
    '',
  ];

  if (session.overview) {
    lines.push(session.overview, '');
  } else {
    lines.push(
      '_Grouped by file, in the order git produced them. A model has not organised this ' +
        'change set — that is what the reading order below would otherwise be._',
      '',
    );
  }

  lines.push('## Review order', '');
  cohorts.forEach((cohort, index) => {
    const risk = cohort.risk === 'low' ? '' : ` **${cohort.risk} risk**`;
    lines.push(`${index + 1}. **${cohort.title}**${risk} — ${cohort.summary || 'no summary'}`);
    if (cohort.riskReason) lines.push(`   - ${cohort.riskReason}`);
    if (cohort.layers.length > 1) {
      for (const layer of cohort.layers) {
        lines.push(`   - ${layer.title} — ${layer.paths.join(', ')}`);
      }
    }
  });
  lines.push('');

  if (session.notes.length > 0) {
    lines.push('## Worth your attention', '');
    for (const note of session.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  if (scaffolding) {
    lines.push(`_${scaffolding.summary}_`, '');
  }

  return lines.join('\n');
}
