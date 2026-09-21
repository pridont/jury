import * as path from 'node:path';
import * as vscode from 'vscode';
import { matchLines } from '../model/lines.js';
import type { SessionHost } from '../session.js';
import { decode } from './content.js';
import { fileForUri } from './diff.js';

type Target = vscode.Location | vscode.LocationLink;

/**
 * Go to definition from a side of the diff that git serves.
 *
 * Language servers read the files on disk. A blob has no folder, tsconfig or package.json
 * around it, so TypeScript reads it as a lone script: an import resolves to nothing, and
 * the definition it offers is the import line in the same blob. The definition a reviewer
 * wants is the one in the working tree, so the position is carried to the file on disk
 * through the lines the two share, and the question is asked there.
 *
 * Only answers in other files are passed back. An answer in the file itself is a position
 * in the version on disk, not the one on screen, and the blob's own language support
 * already finds declarations within the blob.
 */
export class BlobDefinitions implements vscode.DefinitionProvider {
  /** Line pairings per blob, redone when the file on disk changes. */
  private readonly pairings = new WeakMap<vscode.TextDocument, Pairing>();

  constructor(private readonly host: SessionHost) {}

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.LocationLink[] | undefined> {
    const disk = await this.counterpart(document.uri);
    if (!disk || token.isCancellationRequested) return undefined;

    // A line the file on disk does not have (removed, or not written yet) has no position
    // to ask about there.
    const line = this.pair(document, disk)?.[position.line] ?? -1;
    if (line < 0) return undefined;

    const found = await vscode.commands.executeCommand<Target[] | undefined>(
      'vscode.executeDefinitionProvider',
      disk.uri,
      new vscode.Position(line, position.character),
    );
    if (!found || token.isCancellationRequested) return undefined;

    const self = disk.uri.toString();
    return found
      .map(asLink)
      .filter((link) => link.targetUri.toString() !== self)
      .map((link) => onBlob(link, line, position.line));
  }

  /** The working-tree file a blob is a version of. A renamed file is found under its new name. */
  private async counterpart(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    const { root, path: blobPath } = decode(uri);
    if (!root) return undefined;

    const session = this.host.active;
    const located = session ? fileForUri(session, uri) : null;
    try {
      return await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, located?.file.path ?? blobPath)));
    } catch {
      // Deleted in the working tree, or never there: nothing on disk to ask.
      return undefined;
    }
  }

  /** A blob never changes, so its pairing holds until the file on disk does. */
  private pair(blob: vscode.TextDocument, disk: vscode.TextDocument): Int32Array | null {
    const cached = this.pairings.get(blob);
    if (cached?.disk === disk && cached.version === disk.version) return cached.lines;
    const lines = matchLines(linesOf(blob), linesOf(disk));
    this.pairings.set(blob, { disk, version: disk.version, lines });
    return lines;
  }
}

type Pairing = { disk: vscode.TextDocument; version: number; lines: Int32Array | null };

function linesOf(document: vscode.TextDocument): string[] {
  return Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);
}

function asLink(target: Target): vscode.LocationLink {
  return 'targetUri' in target ? target : { targetUri: target.uri, targetRange: target.range };
}

/**
 * Re-home an answer's origin on the blob. The origin is the span the editor underlines, and
 * as asked it is a span on the disk file's line, not the blob's. The two lines are equal, so
 * only the line number moves.
 */
function onBlob(link: vscode.LocationLink, diskLine: number, blobLine: number): vscode.LocationLink {
  const { originSelectionRange: origin, ...rest } = link;
  if (!origin || origin.start.line !== diskLine || origin.end.line !== diskLine) return rest;
  return {
    ...rest,
    originSelectionRange: new vscode.Range(blobLine, origin.start.character, blobLine, origin.end.character),
  };
}
