import * as path from 'node:path';
import * as vscode from 'vscode';
import { documentSymbols } from '../enrich.js';
import { covers } from '../model/comments.js';
import type { Hunk } from '../model/types.js';
import type { Session, SessionHost } from '../session.js';
import { pairLines } from './definitions.js';
import { contentUri, fileForUri } from './diff.js';

/** Symbols that hold others: a change inside one is a change to the member, not the whole. */
const CONTAINERS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Namespace,
  vscode.SymbolKind.Module,
  vscode.SymbolKind.Struct,
]);

class UsesLens extends vscode.CodeLens {
  constructor(
    range: vscode.Range,
    /** The document the lens is drawn on, where the peek opens. */
    readonly shown: vscode.Uri,
    /** The working-tree file, where the language server can answer. */
    readonly disk: vscode.TextDocument,
    readonly symbol: vscode.DocumentSymbol,
  ) {
    super(range);
  }
}

/**
 * How much code outside the change uses what the change touched.
 *
 * A diff shows a function's new body and none of its callers, and the callers are where a
 * change breaks things. Above each symbol the change touches, a lens counts the places that
 * use it and are not themselves part of the change; clicking it peeks at them.
 *
 * Language servers read the files on disk, so the question is asked there, as go to
 * definition does. For a review whose head is not checked out that is the working tree's
 * idea of the callers — still the code the change has to keep working with.
 */
export class OutsideUses implements vscode.CodeLensProvider<UsesLens> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly host: SessionHost) {
    host.onDidChange(() => this.changed.fire());
  }

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<UsesLens[]> {
    const session = this.host.active;
    const located = session ? fileForUri(session, document.uri) : null;
    if (!session || !located || located.side !== 'new') return [];
    const hunks = located.file.hunks.filter((hunk) => hunk.kind === 'text' && !hunk.scaffolding);
    if (hunks.length === 0) return [];

    const disk = await onDisk(session, located.file.path);
    if (!disk || token.isCancellationRequested) return [];

    // Lines of the document on screen, as lines of the file on disk, and back.
    const same = disk.uri.toString() === document.uri.toString();
    const there = same ? null : pairLines(document, disk);
    const back = same ? null : pairLines(disk, document);
    if (!same && (!there || !back)) return [];
    const toDisk = (line: number) => (there ? (there[line] ?? -1) : line);
    const toShown = (line: number) => (back ? (back[line] ?? -1) : line);

    const symbols = await documentSymbols(disk.uri);
    if (!symbols || token.isCancellationRequested) return [];

    const touched = new Set<vscode.DocumentSymbol>();
    for (const [before, at] of hunks.flatMap(changedLines)) {
      const symbol = symbolAt(symbols, toDisk(at));
      // A removal sits between two lines: it changed a symbol only if both are inside it.
      if (symbol && (before === undefined || symbolAt(symbols, toDisk(before)) === symbol)) touched.add(symbol);
    }

    return [...touched].flatMap((symbol) => {
      const line = toShown(symbol.selectionRange.start.line);
      return line < 0 ? [] : [new UsesLens(new vscode.Range(line, 0, line, 0), document.uri, disk, symbol)];
    });
  }

  async resolveCodeLens(lens: UsesLens, token: vscode.CancellationToken): Promise<UsesLens> {
    const found =
      (await vscode.commands.executeCommand<vscode.Location[] | undefined>(
        'vscode.executeReferenceProvider',
        lens.disk.uri,
        lens.symbol.selectionRange.start,
      )) ?? [];

    const session = this.host.active;
    const self = lens.disk.uri.toString();
    const outside: vscode.Location[] = [];
    for (const location of found) {
      if (token.isCancellationRequested) return lens;
      // The declaration, and recursion, are the symbol itself.
      if (location.uri.toString() === self && lens.symbol.range.contains(location.range)) continue;
      if (session && (await inChange(session, location))) continue;
      outside.push(location);
    }

    const files = new Set(outside.map((location) => location.uri.toString())).size;
    lens.command =
      outside.length === 0
        ? { title: 'no uses outside this change', command: '' }
        : {
            title:
              `${outside.length} use${outside.length === 1 ? '' : 's'} outside this change` +
              ` · ${files} file${files === 1 ? '' : 's'}`,
            command: 'editor.action.showReferences',
            arguments: [lens.shown, lens.range.start, outside],
          };
    return lens;
  }
}

/**
 * The new-side lines a hunk changes, 0-based. An added line is itself; a removal has no line
 * of its own on the new side, so it is the pair of lines it sat between.
 */
function changedLines(hunk: Hunk): [before: number | undefined, at: number][] {
  const changed: [number | undefined, number][] = [];
  let line = hunk.newStart - 1;
  for (const text of hunk.lines) {
    if (text[0] === '+') changed.push([undefined, line++]);
    else if (text[0] === '-') changed.push([line - 1, line]);
    else if (text[0] !== '\\') line++;
  }
  return changed;
}

/** The symbol other code would name for `line`: a top-level one, or a member of a container. */
function symbolAt(symbols: vscode.DocumentSymbol[], line: number): vscode.DocumentSymbol | undefined {
  if (line < 0) return undefined;
  const symbol = symbols.find((s) => s.range.start.line <= line && line <= s.range.end.line);
  if (!symbol) return undefined;
  return (CONTAINERS.has(symbol.kind) ? symbolAt(symbol.children, line) : undefined) ?? symbol;
}

/**
 * Whether a use is code the reviewer is already reading. A use in a file of the change is
 * placed on its new side; a line the new side does not have was rewritten by the change.
 */
async function inChange(session: Session, location: vscode.Location): Promise<boolean> {
  if (location.uri.scheme !== 'file') return false;
  const relative = path.relative(session.repo.root, location.uri.fsPath).split(path.sep).join('/');
  const file = session.files.find((candidate) => candidate.path === relative);
  if (!file) return false;

  let line = location.range.start.line;
  if (session.spec.kind !== 'worktree') {
    const disk = await vscode.workspace.openTextDocument(location.uri);
    const head = await vscode.workspace.openTextDocument(contentUri(session, file));
    const pairing = pairLines(disk, head);
    if (!pairing) return false;
    line = pairing[line] ?? -1;
    if (line < 0) return true;
  }
  return file.hunks.some((hunk) => covers(hunk, 'new', line + 1));
}

async function onDisk(session: Session, file: string): Promise<vscode.TextDocument | undefined> {
  try {
    return await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(session.repo.root, file)));
  } catch {
    // Not in the working tree: nothing on disk to ask.
    return undefined;
  }
}
