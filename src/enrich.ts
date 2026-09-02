import * as vscode from 'vscode';
import type { FileChange } from './git/parse.js';

/**
 * Name the function or class each hunk sits in.
 *
 * git's own `@@ ... @@` heading is a regex guess and is already in place; a language server
 * knows. This overwrites the guess only when a provider actually answers, and does nothing
 * at all when there is no provider, no open document, or no symbol at that line — an
 * enrichment that fails costs a label, never the review.
 */
export async function enrichSymbols(files: FileChange[], uriFor: (file: FileChange) => vscode.Uri | null): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      if (file.binary || file.hunks.every((h) => h.kind !== 'text')) return;
      const uri = uriFor(file);
      if (!uri) return;

      const symbols = await documentSymbols(uri);
      if (!symbols) return;

      for (const hunk of file.hunks) {
        if (hunk.kind !== 'text') continue;
        const name = innermostSymbolAt(symbols, hunk.newStart - 1);
        if (name) hunk.symbol = name;
      }
    }),
  );
}

async function documentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[] | null> {
  try {
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    return result && result.length > 0 && 'range' in result[0]! ? result : null;
  } catch {
    return null;
  }
}

/** The most specific symbol containing `line`, qualified by its parents. */
function innermostSymbolAt(symbols: vscode.DocumentSymbol[], line: number, prefix = ''): string | null {
  for (const symbol of symbols) {
    if (line < symbol.range.start.line || line > symbol.range.end.line) continue;
    const qualified = prefix ? `${prefix}.${symbol.name}` : symbol.name;
    return innermostSymbolAt(symbol.children, line, qualified) ?? qualified;
  }
  return null;
}
