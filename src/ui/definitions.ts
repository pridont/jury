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
    const line = pairLines(document, disk)?.[position.line] ?? -1;
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
}

/** Line pairings per document, redone when either side of the pair changes. */
const pairings = new WeakMap<vscode.TextDocument, Pairing>();

type Pairing = { other: vscode.TextDocument; versions: [number, number]; lines: Int32Array | null };

/** For each line of `a`, the same line in `b` or -1; null when the two are too far apart to pair. */
export function pairLines(a: vscode.TextDocument, b: vscode.TextDocument): Int32Array | null {
  const cached = pairings.get(a);
  if (cached?.other === b && cached.versions[0] === a.version && cached.versions[1] === b.version) return cached.lines;
  const lines = matchLines(linesOf(a), linesOf(b));
  pairings.set(a, { other: b, versions: [a.version, b.version], lines });
  return lines;
}

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
