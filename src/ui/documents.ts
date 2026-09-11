import * as vscode from 'vscode';

export const DOC_SCHEME = 'jury-doc';

/**
 * Documents the extension writes for you to read, rather than to keep.
 *
 * An untitled document made with `openTextDocument({ content })` is dirty from the moment it
 * exists, so closing the walkthrough asks whether to save a file that was never yours. These
 * are served from a provider instead: never dirty, never prompt, and the tab carries a name
 * — `Walkthrough.md` — rather than `Untitled-2`.
 */
export class Documents implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? '';
  }

  /** Put `content` behind `name` and open it. Reopening the same name replaces it in place. */
  async show(name: string, content: string, options: { preview?: boolean } = {}): Promise<vscode.TextDocument> {
    const uri = vscode.Uri.from({ scheme: DOC_SCHEME, path: `/${name}` });
    this.contents.set(uri.path, content);
    this.changed.fire(uri);

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: options.preview ?? true, preserveFocus: false });
    return document;
  }

  dispose(): void {
    this.contents.clear();
    this.changed.dispose();
  }
}

/**
 * Offer to keep one of these, since a read-only document cannot simply be saved.
 *
 * The export is the one document a reviewer may actually want on disk, and asking where is
 * better than handing them a dirty buffer and hoping.
 */
export async function offerToSave(content: string, suggested: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    'Jury: review exported.',
    'Save to a file…',
    'Copy',
  );
  if (choice === 'Copy') {
    await vscode.env.clipboard.writeText(content);
    return;
  }
  if (choice !== 'Save to a file…') return;

  const target = await vscode.window.showSaveDialog({
    saveLabel: 'Save review',
    filters: { Markdown: ['md'] },
    defaultUri: vscode.workspace.workspaceFolders?.[0]
      ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, suggested)
      : vscode.Uri.file(suggested),
  });
  if (!target) return;

  await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
}
