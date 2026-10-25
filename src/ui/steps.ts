import * as vscode from 'vscode';
import { contentSide } from '../git/parse.js';
import { buildOrder, stepStarts, type Entry } from '../model/order.js';
import type { SessionHost } from '../session.js';
import { fileForUri } from './diff.js';

/**
 * How many characters of a lens can be read. A lens does not wrap, so what runs past the
 * editor's edge is lost, and an extension cannot ask how wide the editor is.
 */
// ponytail: a fixed budget sized for an editor beside the sidebar; narrower splits still cut.
const FITS = 100;

/**
 * One thing said about a step: the line it is said on, as much as fits on a lens, the least
 * that names it, and all of it.
 */
type Note = { line: number; shown: string; brief: string; full: string; warning: boolean };

/**
 * What a diff editor gets instead of lenses: faint text after the line, coloured as a lens
 * is, since VS Code hides lenses in diff editors unless `diffEditor.codeLens` is on.
 */
const AFTER = vscode.window.createTextEditorDecorationType({
  after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2em' },
});

/**
 * What a step is for, written on the code where it begins.
 *
 * The tree and the walkthrough say why a step is there, but neither is in view while its
 * code is: the tree is a glance away, and focus mode hides it. Someone reading without
 * knowing what to look for reads past it, so the step's title and summary go above its
 * first line. A cohort that is not what the author described says so there too, before
 * the code is read with the description's expectation.
 *
 * Above the line as a code lens in a plain editor. A diff editor hides lenses by default,
 * and most of a review is read in one, so there the same words go after the line instead.
 */
export class StepLenses implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  /** The text after each line of each document drawn in a diff editor, as last drawn. */
  readonly drawn = new Map<string, string[]>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly host: SessionHost) {
    this.subscriptions = [
      host.onDidChange(() => {
        this.changed.fire();
        this.draw();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.draw()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.draw()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('diffEditor.codeLens')) this.draw();
      }),
    ];
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return this.notes(document).map(
      (note) =>
        new vscode.CodeLens(new vscode.Range(note.line, 0, note.line, 0), {
          title: note.warning ? `$(warning) ${note.shown}` : note.shown,
          tooltip: note.full,
          command: '',
        }),
    );
  }

  /** Into every diff editor that hides lenses, the notes after their lines; nothing elsewhere. */
  private draw(): void {
    const hidden = !vscode.workspace.getConfiguration('diffEditor').get<boolean>('codeLens', false);
    this.drawn.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      const notes = hidden && inDiff(editor) ? this.notes(editor.document) : [];
      // Notes on one line share it, as lenses on one line do.
      const byLine = new Map<number, Note[]>();
      for (const note of notes) byLine.set(note.line, [...(byLine.get(note.line) ?? []), note]);
      const options = [...byLine].map(([line, here]) => ({
        // The whole line, so hovering it shows everything the text after it had to leave out.
        range: editor.document.lineAt(line).range,
        hoverMessage: new vscode.MarkdownString(here.map((note) => note.full).join('\n\n')),
        // Only what names the step: it shares a line with code, in a pane half the editor wide.
        renderOptions: { after: { contentText: here.map((note) => (note.warning ? `⚠ ${note.brief}` : note.brief)).join('  ·  ') } },
      }));
      editor.setDecorations(AFTER, options);
      if (options.length > 0) this.drawn.set(editor.document.uri.toString(), options.map((o) => o.renderOptions.after.contentText));
    }
  }

  private notes(document: vscode.TextDocument): Note[] {
    const session = this.host.active;
    const located = session ? fileForUri(session, document.uri) : null;
    // One side of a diff is enough; both would say everything twice.
    if (!session || !located || located.side !== contentSide(located.file)) return [];

    const order = buildOrder(session.cohorts, session.files);
    return stepStarts(order, located.file.path, located.side).flatMap((entry) => {
      // The heuristic's steps are files, and the tab already names the file.
      if (entry.cohort.origin !== 'ai') return [];
      // On a trail stop's key line, when it has one: the note and the line it is about together.
      const start = entry.hunk.focus ?? (located.side === 'old' ? entry.hunk.oldStart : entry.hunk.newStart);
      const line = Math.min(Math.max(0, start - 1), Math.max(0, document.lineCount - 1));

      const notes: Note[] = [];
      // On where the cohort begins, and first, so a long step title cannot push it out of sight.
      const mismatch = entry.cohort.mismatch;
      if (mismatch && entry.layerIndex === 0) {
        const said = `Not as described: ${mismatch}`;
        notes.push({ line, shown: fit(said, 'Not as described …'), brief: 'Not as described …', full: said, warning: true });
      }
      const { title, summary } = describe(entry);
      const said = summary ? `${title} — ${summary}` : title;
      const first = summary.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? summary;
      // Whole sentences or none: a summary cut mid-sentence reads as a different claim.
      const shown = fit(said, `${title} — ${first}${first === summary ? '' : ' …'}`, summary ? `${title} …` : title);
      notes.push({ line, shown, brief: summary ? `${title} …` : title, full: said, warning: false });
      return notes;
    });
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(AFTER, []);
  }
}

/**
 * Whether `editor` is a pane of a diff editor: of the text diff, or one of the multi-file
 * diff's, that is the active tab of its group. The multi-file input is not in the typings
 * this extension builds against, so it is recognised by its shape.
 */
function inDiff(editor: vscode.TextEditor): boolean {
  const uri = editor.document.uri.toString();
  return vscode.window.tabGroups.all.some((group) => {
    if (editor.viewColumn !== undefined && group.viewColumn !== editor.viewColumn) return false;
    const input = group.activeTab?.input;
    const diffs = input instanceof vscode.TabInputTextDiff ? [input] : ((input as { textDiffs?: vscode.TabInputTextDiff[] } | undefined)?.textDiffs ?? []);
    return diffs.some((diff) => diff.original.toString() === uri || diff.modified.toString() === uri);
  });
}

/** The first of `choices`, longest first, that can be read whole; the shortest when none can. */
function fit(...choices: string[]): string {
  return choices.find((choice) => choice.length <= FITS) ?? choices.at(-1)!;
}

/** A cohort of one step is that step, as in the tree; otherwise the step speaks for itself. */
function describe(entry: Entry): { title: string; summary: string } {
  const number = `${entry.cohortIndex + 1}.`;
  if (entry.cohort.layers.length === 1) {
    return { title: `${number} ${entry.cohort.title}`, summary: entry.cohort.summary || entry.layer.summary };
  }
  return { title: `${number} ${entry.layer.title}`, summary: entry.layer.summary };
}

