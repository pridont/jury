import * as vscode from 'vscode';
import { contentSide, type FileChange } from '../git/parse.js';
import type { Session } from '../session.js';
import { contentUri, openFileDiff, openMultiDiff, sidesFor } from './diff.js';
import { layerEntry, step, stepLayer, type Entry } from '../model/order.js';

export { buildOrder, type Entry } from '../model/order.js';

/** Code that did not change at all. Dim means "not part of this diff", one meaning only. */
const UNCHANGED = vscode.window.createTextEditorDecorationType({ opacity: '0.45' });

/** The hunks of the layer being read, marked rather than un-dimmed. */
const ACTIVE = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  borderWidth: '0 0 0 2px',
  borderStyle: 'solid',
  borderColor: new vscode.ThemeColor('focusBorder'),
});

/** Walks the reading order and keeps the editor pointed at the current hunk. */
export class Navigator implements vscode.Disposable {
  private order: Entry[] = [];
  private position = -1;
  /** Set while a move is opening an editor, so the selection it causes is not read back. */
  private moving = false;
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

    this.moving = true;
    try {
      const changingFile = !previous || previous.file.path !== entry.file.path;
      const shown = this.showing(entry.file);
      const editor = changingFile || !shown ? await this.open(entry) : shown;

      if (editor) {
        reveal(editor, entry);
        focusLayer(editor, entry, this.order);
      }
    } finally {
      this.moving = false;
    }
    this.changed.fire(entry);
  }

  /**
   * Open what the reader needs to see.
   *
   * A layer is a step in the reading, and a step routinely spans files. Opening every file
   * of the layer at once means the step arrives whole, rather than one file at a time with
   * no way to see what else it touches.
   */
  private async open(entry: Entry): Promise<vscode.TextEditor | undefined> {
    const others = entry.layer.paths.length;
    if (others > 1) {
      const files = entry.layer.paths
        .map((path) => this.session.files.find((file) => file.path === path))
        .filter((file): file is FileChange => file !== undefined);
      await openMultiDiff(this.session, entry.layer.title, files);
    }
    return openFileDiff(this.session, entry.file);
  }

  /**
   * The editor already showing this file's content.
   *
   * Matched on the exact URI of the side that holds it rather than on the path: the two
   * sides of a deletion differ only by the revision in the query, so a path match can hand
   * back the empty pane, where every reveal silently does nothing.
   */
  private showing(file: FileChange): vscode.TextEditor | undefined {
    const uri = contentUri(this.session, file).toString();
    return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uri);
  }

  /** Map a cursor back onto a hunk, so clicking in the diff moves the review with it. */
  syncFromEditor(editor: vscode.TextEditor): void {
    // A move sets the selection itself; reading that back would undo the move it just made.
    if (this.moving) return;
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
      focusLayer(editor, this.order[index]!, this.order);
      this.changed.fire(this.current);
    }
  }

  /** Open every file of the current layer together, without moving the reading position. */
  async openLayerFiles(): Promise<void> {
    const entry = this.current;
    if (!entry) return;
    const files = entry.layer.paths
      .map((path) => this.session.files.find((file) => file.path === path))
      .filter((file): file is FileChange => file !== undefined);
    await openMultiDiff(this.session, entry.layer.title, files);
  }

  /** Jump to a named file inside a layer, for the file rows under it in the tree. */
  async goToLayerFile(cohortIndex: number, layerIndex: number, path: string): Promise<void> {
    const index = this.order.findIndex(
      (entry) =>
        entry.cohortIndex === cohortIndex && entry.layerIndex === layerIndex && entry.file.path === path,
    );
    if (index !== -1) await this.moveTo(index);
  }

  dispose(): void {
    this.changed.dispose();
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(UNCHANGED, []);
      editor.setDecorations(ACTIVE, []);
    }
  }
}

function contains(start: number, count: number, line: number): boolean {
  return count > 0 ? line >= start && line < start + count : line === start;
}

function reveal(editor: vscode.TextEditor, entry: Entry): void {
  const line = Math.max(0, (entry.hunk.newCount > 0 ? entry.hunk.newStart : entry.hunk.oldStart) - 1);
  const position = new vscode.Position(Math.min(line, Math.max(0, editor.document.lineCount - 1)), 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/**
 * Mark the layer being read, and dim what did not change.
 *
 * These are two different statements and they get two different signals. Dimming means "this
 * code is not part of the diff" and nothing else; a border marks the hunks of the step being
 * read. Using dimness for both would say the same thing about unchanged context and about a
 * hunk that simply belongs to a later step.
 */
function focusLayer(editor: vscode.TextEditor, entry: Entry, order: readonly Entry[]): void {
  const inFile = order.filter((other) => other.file.path === entry.file.path);
  const lastLine = Math.max(0, editor.document.lineCount - 1);

  // Line numbers are per side, and a deleted file is only ever open on its old one. Reading
  // the new side's there would put every hunk at line 0 and dim the whole file as context.
  const side = contentSide(entry.file);
  const rangeOf = (other: Entry): vscode.Range => {
    const at = side === 'old' ? other.hunk.oldStart : other.hunk.newStart;
    const count = side === 'old' ? other.hunk.oldCount : other.hunk.newCount;
    const start = Math.min(Math.max(0, at - 1), lastLine);
    const end = Math.min(start + Math.max(count, 1) - 1, lastLine);
    return new vscode.Range(start, 0, end, 0);
  };

  const changed = inFile.map(rangeOf).sort((a, b) => a.start.line - b.start.line);
  const active = inFile
    .filter((other) => other.cohortIndex === entry.cohortIndex && other.layerIndex === entry.layerIndex)
    .map(rangeOf);

  const unchanged: vscode.Range[] = [];
  let cursor = 0;
  for (const range of changed) {
    if (range.start.line > cursor) unchanged.push(new vscode.Range(cursor, 0, range.start.line - 1, 0));
    cursor = Math.max(cursor, range.end.line + 1);
  }
  if (cursor <= lastLine) unchanged.push(new vscode.Range(cursor, 0, lastLine, 0));

  editor.setDecorations(UNCHANGED, unchanged);
  editor.setDecorations(ACTIVE, active);
}
