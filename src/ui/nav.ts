import * as vscode from 'vscode';
import type { FileChange } from '../git/parse.js';
import type { Session } from '../session.js';
import { openFileDiff, sidesFor } from './diff.js';
import { layerEntry, step, stepLayer, type Entry } from '../model/order.js';

export { buildOrder, type Entry } from '../model/order.js';

const DIM = vscode.window.createTextEditorDecorationType({ opacity: '0.4' });

/** Walks the reading order and keeps the editor pointed at the current hunk. */
export class Navigator implements vscode.Disposable {
  private order: Entry[] = [];
  private position = -1;
  private readonly changed = new vscode.EventEmitter<Entry | null>();
  readonly onDidChange = this.changed.event;

  constructor(private session: Session) {}

  setOrder(order: Entry[]): void {
    this.order = order;
    this.position = order.length > 0 ? 0 : -1;
    this.changed.fire(this.current);
  }

  setSession(session: Session): void {
    this.session = session;
  }

  get entries(): readonly Entry[] {
    return this.order;
  }

  get current(): Entry | null {
    return this.order[this.position] ?? null;
  }

  /** How much of the review a person is expected to read — scaffolding is not counted. */
  get progress(): { reviewed: number; total: number } {
    const total = this.order.filter((entry) => !entry.scaffolding).length;
    const reviewed = this.order.filter(
      (entry) => !entry.scaffolding && this.session.marks.has(entry.hunk.id),
    ).length;
    return { reviewed, total };
  }

  async next(): Promise<void> {
    await this.step(1);
  }

  async previous(): Promise<void> {
    await this.step(-1);
  }

  /** Jump to a layer's first unreviewed hunk, or its first hunk when all are reviewed. */
  async goToLayer(cohortIndex: number, layerIndex: number): Promise<void> {
    const index = layerEntry(this.order, cohortIndex, layerIndex, (id) => this.session.marks.has(id));
    if (index !== -1) await this.moveTo(index);
  }

  async goToHunk(hunkId: string): Promise<void> {
    const index = this.order.findIndex((entry) => entry.hunk.id === hunkId);
    if (index !== -1) await this.moveTo(index);
  }

  /**
   * Step through the reading order, crossing file, layer and cohort boundaries on the way.
   *
   * Scaffolding is skipped, because it is not what the reviewer is here to read — unless
   * they deliberately went there, in which case walking it works like anywhere else.
   */
  private async step(direction: 1 | -1): Promise<void> {
    if (this.order.length === 0) return;
    const next = step(this.order, this.position, direction);
    if (next !== this.position) await this.moveTo(next);
  }

  /** Move to the next or previous layer, landing on its first unread hunk. */
  async stepLayer(direction: 1 | -1): Promise<void> {
    const next = stepLayer(this.order, this.position, direction);
    if (next === this.position) return;
    const entry = this.order[next]!;
    await this.goToLayer(entry.cohortIndex, entry.layerIndex);
  }

  private async moveTo(index: number): Promise<void> {
    const previous = this.current;
    this.position = index;
    const entry = this.current;
    if (!entry) return;

    if (!previous || previous.file.path !== entry.file.path || !isShowing(entry.file)) {
      await openFileDiff(this.session, entry.file);
    }
    reveal(entry);
    focusLayer(entry, this.order);
    this.changed.fire(entry);
  }

  /** Map a cursor back onto a hunk, so clicking in the diff moves the review with it. */
  syncFromEditor(editor: vscode.TextEditor): void {
    const line = editor.selection.active.line + 1;
    const uri = editor.document.uri.toString();

    const index = this.order.findIndex((entry) => {
      const { before, after } = sidesFor(this.session, entry.file);
      if (uri === after.toString()) return contains(entry.hunk.newStart, entry.hunk.newCount, line);
      if (uri === before.toString()) return contains(entry.hunk.oldStart, entry.hunk.oldCount, line);
      return false;
    });

    if (index !== -1 && index !== this.position) {
      this.position = index;
      focusLayer(this.order[index]!, this.order);
      this.changed.fire(this.current);
    }
  }

  dispose(): void {
    this.changed.dispose();
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(DIM, []);
  }
}

function contains(start: number, count: number, line: number): boolean {
  return count > 0 ? line >= start && line < start + count : line === start;
}

function isShowing(file: FileChange): boolean {
  return vscode.window.visibleTextEditors.some((editor) => editor.document.uri.path.endsWith(`/${file.path}`));
}

function reveal(entry: Entry): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const line = Math.max(0, (entry.hunk.newCount > 0 ? entry.hunk.newStart : entry.hunk.oldStart) - 1);
  const position = new vscode.Position(Math.min(line, Math.max(0, editor.document.lineCount - 1)), 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/**
 * Dim what is not part of the layer being read.
 *
 * The diff editor cannot be told to show only some ranges, and hiding code in a review tool
 * would be worse than showing it: this says "not this, yet" without taking anything away.
 */
function focusLayer(entry: Entry, order: readonly Entry[]): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const inLayer = order.filter(
    (other) =>
      other.cohortIndex === entry.cohortIndex &&
      other.layerIndex === entry.layerIndex &&
      other.file.path === entry.file.path,
  );

  const lit: vscode.Range[] = inLayer.map((other) => {
    const start = Math.max(0, other.hunk.newStart - 1);
    const end = Math.max(start, start + Math.max(other.hunk.newCount, 1) - 1);
    return new vscode.Range(start, 0, Math.min(end, editor.document.lineCount - 1), 0);
  });

  const dim: vscode.Range[] = [];
  let cursor = 0;
  for (const range of lit.sort((a, b) => a.start.line - b.start.line)) {
    if (range.start.line > cursor) dim.push(new vscode.Range(cursor, 0, range.start.line - 1, 0));
    cursor = Math.max(cursor, range.end.line + 1);
  }
  if (cursor < editor.document.lineCount) {
    dim.push(new vscode.Range(cursor, 0, editor.document.lineCount - 1, 0));
  }

  editor.setDecorations(DIM, dim);
}
