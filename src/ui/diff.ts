import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FileChange } from '../git/parse.js';
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

/** Open one file's diff and return the editor showing the new side, when there is one. */
export async function openFileDiff(session: Session, file: FileChange): Promise<vscode.TextEditor | undefined> {
  const { before, after } = sidesFor(session, file);
  await vscode.commands.executeCommand('vscode.diff', before, after, diffTitle(file), {
    preview: true,
    preserveFocus: false,
  });
  return vscode.window.activeTextEditor;
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
