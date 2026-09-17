import * as path from 'node:path';
import * as vscode from 'vscode';
import { contentSide, type FileChange } from '../git/parse.js';
import type { Session } from '../session.js';
import { blobUri, emptyUri } from './content.js';

export type Sides = { before: vscode.Uri; after: vscode.Uri };

/**
 * The two sides of one file.
 *
 * For a worktree review the new side is the real file, so LSP attaches, go-to-definition
 * works, and a typo can be fixed without leaving the review. For every other kind both
 * sides are read-only blobs: a review tool does not check out other people's branches
 * behind their back.
 */
export function sidesFor(session: Session, file: FileChange): Sides {
  const root = session.repo.root;
  const oldPath = file.oldPath ?? file.path;

  const before = file.status === 'added' ? emptyUri(root, file.path) : blobUri(root, oldPath, session.base);

  if (file.status === 'deleted') {
    return { before, after: emptyUri(root, file.path) };
  }
  if (session.spec.kind === 'worktree') {
    return { before, after: vscode.Uri.file(path.join(root, file.path)) };
  }
  return { before, after: blobUri(root, file.path, session.head) };
}

/** The side of `file` that has content: the base for a deletion, the head for everything else. */
export function contentUri(session: Session, file: FileChange): vscode.Uri {
  const { before, after } = sidesFor(session, file);
  return contentSide(file) === 'old' ? before : after;
}

/** Which file and side a document belongs to, or null when it is not part of the review. */
export function fileForUri(
  session: Session,
  uri: vscode.Uri,
): { file: FileChange; side: 'old' | 'new' } | null {
  const key = uri.toString();
  for (const file of session.files) {
    const { before, after } = sidesFor(session, file);
    if (key === after.toString()) return { file, side: 'new' };
    if (key === before.toString()) return { file, side: 'old' };
  }
  return null;
}

export function diffTitle(file: FileChange): string {
  const name = path.basename(file.path);
  if (file.status === 'renamed' || file.status === 'copied') {
    return `${path.basename(file.oldPath ?? file.path)} → ${name}`;
  }
  return `${name} (${file.status})`;
}

/**
 * Open one file's diff and return the editor showing it.
 *
 * An added file opens on its own. Two panes, one of them blank, with every line painted as
 * an addition say nothing that one pane does not: reading a new file is just reading a file.
 *
 * A deletion is not the same case. Its old content on its own is indistinguishable from the
 * file still being there — same name in the tab, same code in the pane — so it opens as a
 * diff against nothing, where the title says `(deleted)` and every line is a removal.
 */
export async function openFileDiff(session: Session, file: FileChange): Promise<vscode.TextEditor | undefined> {
  const { before, after } = sidesFor(session, file);

  if (file.status === 'added') {
    const document = await vscode.workspace.openTextDocument(after);
    return vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
  }

  await vscode.commands.executeCommand('vscode.diff', before, after, diffTitle(file), {
    preview: true,
    preserveFocus: false,
  });

  // `activeTextEditor` is not reliably the editor the command just opened, and revealing in
  // the wrong one puts the cursor back in the file being left — which then syncs the
  // position back and makes the next-hunk key look broken. The side with the content comes
  // first: the other pane of a deletion is empty, and revealing a hunk there reveals nothing.
  const content = contentUri(session, file);
  const other = content.toString() === after.toString() ? before : after;
  return editorFor(content) ?? editorFor(other) ?? vscode.window.activeTextEditor;
}

function editorFor(uri: vscode.Uri): vscode.TextEditor | undefined {
  const key = uri.toString();
  return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === key);
}

/**
 * Open every file of a cohort or layer in one multi-file diff editor.
 *
 * `vscode.changes` is the only VS Code API this design bets on, so it is probed rather than
 * assumed: when it is not there, the files open as ordinary diffs instead and the review is
 * no worse than it was.
 */
export async function openMultiDiff(session: Session, title: string, files: FileChange[]): Promise<boolean> {
  if (files.length === 0) return false;
  if (files.length === 1) {
    await openFileDiff(session, files[0]!);
    return true;
  }

  const resources = files.map((file) => {
    const { before, after } = sidesFor(session, file);
    return [vscode.Uri.file(path.join(session.repo.root, file.path)), before, after];
  });

  if (await hasMultiDiffEditor()) {
    try {
      await vscode.commands.executeCommand('vscode.changes', title, resources);
      return true;
    } catch {
      // Fall through to per-file diffs.
    }
  }

  for (const file of files) {
    await openFileDiff(session, file);
  }
  return false;
}

let multiDiff: boolean | undefined;

async function hasMultiDiffEditor(): Promise<boolean> {
  if (multiDiff === undefined) {
    multiDiff = (await vscode.commands.getCommands(true)).includes('vscode.changes');
  }
  return multiDiff;
}
