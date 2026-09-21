import * as vscode from 'vscode';
import { run } from '../util/exec.js';

export const SCHEME = 'jury';

/** A side that does not exist — the base of an added file, the head of a deleted one. */
const EMPTY_REV = 'empty';

type Params = { root: string; path: string; rev: string };

/**
 * Serves the read-only side of a diff straight out of git.
 *
 * No temp files and no checkout: reviewing someone else's branch must not touch the working
 * tree. The worktree review keeps the real file on the new side instead, so a language
 * server is attached and a typo can be fixed in place.
 */
export class BlobProvider implements vscode.TextDocumentContentProvider {
  private readonly cache = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const { root, path, rev } = decode(uri);
    if (rev === EMPTY_REV) return '';

    const spec = rev === 'index' ? `:${path}` : `${rev}:${path}`;
    const result = await run('git', ['show', '--textconv', spec], { cwd: root, timeoutMs: 30_000 }).catch(
      () => null,
    );

    // A path that does not exist at that revision is an addition, not an error to shout
    // about: the empty side is exactly what the diff editor should show.
    const content = result && result.code === 0 ? result.stdout : '';
    this.cache.set(key, content);
    return content;
  }

  /** Drop cached blobs; content at a revision is immutable, so this is only for refresh. */
  clear(): void {
    this.cache.clear();
  }
}

export function blobUri(root: string, path: string, rev: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    // The revision rides in the authority as well as the query. TypeScript names a document
    // by scheme, authority and path and drops the query, so without it the base and head of
    // one file are the same document to it — and whichever opened first answers for both.
    authority: rev.toLowerCase().replace(/[^a-z0-9.-]+/g, '-'),
    path: `/${path}`,
    query: new URLSearchParams({ root, path, rev }).toString(),
  });
}

export function emptyUri(root: string, path: string): vscode.Uri {
  return blobUri(root, path, EMPTY_REV);
}

export function decode(uri: vscode.Uri): Params {
  const params = new URLSearchParams(uri.query);
  return {
    root: params.get('root') ?? '',
    path: params.get('path') ?? uri.path.replace(/^\//, ''),
    rev: params.get('rev') ?? 'HEAD',
  };
}
