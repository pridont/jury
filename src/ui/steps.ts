import * as vscode from 'vscode';
import { contentSide } from '../git/parse.js';
import { buildOrder, stepStarts, type Entry } from '../model/order.js';
import type { SessionHost } from '../session.js';
import { fileForUri } from './diff.js';

/**
 * What a step is for, written on the code where it begins.
 *
 * The tree and the walkthrough say why a step is there, but neither is in view while its
 * code is: the tree is a glance away, and focus mode hides it. Someone reading without
 * knowing what to look for reads past it, so the step's title and summary go above its
 * first line. A cohort that is not what the author described says so there too, before
 * the code is read with the description's expectation.
 */
export class StepLenses implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly host: SessionHost) {
    host.onDidChange(() => this.changed.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const session = this.host.active;
    const located = session ? fileForUri(session, document.uri) : null;
    // One side of a diff is enough; both would say everything twice.
    if (!session || !located || located.side !== contentSide(located.file)) return [];

    const order = buildOrder(session.cohorts, session.files);
    return stepStarts(order, located.file.path, located.side).flatMap((entry) => {
      // The heuristic's steps are files, and the tab already names the file.
      if (entry.cohort.origin !== 'ai') return [];
      const start = located.side === 'old' ? entry.hunk.oldStart : entry.hunk.newStart;
      const line = Math.min(Math.max(0, start - 1), Math.max(0, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);

      const lenses: vscode.CodeLens[] = [];
      // On where the cohort begins, and first, so a long step title cannot push it out of sight.
      const mismatch = entry.cohort.mismatch;
      if (mismatch && entry.layerIndex === 0) {
        const said = `Not as described: ${mismatch}`;
        lenses.push(new vscode.CodeLens(range, { title: `$(warning) ${said}`, tooltip: said, command: '' }));
      }
      const { title, summary } = describe(entry);
      const said = summary ? `${title} — ${summary}` : title;
      lenses.push(new vscode.CodeLens(range, { title: said, tooltip: said, command: '' }));
      return lenses;
    });
  }
}

/** A cohort of one step is that step, as in the tree; otherwise the step speaks for itself. */
function describe(entry: Entry): { title: string; summary: string } {
  const number = `${entry.cohortIndex + 1}.`;
  if (entry.cohort.layers.length === 1) {
    return { title: `${number} ${entry.cohort.title}`, summary: entry.cohort.summary || entry.layer.summary };
  }
  return { title: `${number} ${entry.layer.title}`, summary: entry.layer.summary };
}

