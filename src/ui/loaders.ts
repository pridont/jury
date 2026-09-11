import * as vscode from 'vscode';
import type { ActivityKind } from './activity.js';

const KINDS: readonly ActivityKind[] = ['scanning', 'answering', 'deliberating'];

/** The colour VS Code draws its own icons in, on light and on dark themes. */
const INK = { light: '#424242', dark: '#C5C5C5' } as const;

/**
 * The animated loading icons, coloured for the current theme.
 *
 * The SVGs in `media/` use `currentColor` so they can be recoloured. The tree draws an icon
 * file as an image, where `currentColor` has nothing to inherit and comes out black, which is
 * invisible on a dark theme. So each loader is written out once per theme with a fixed colour,
 * and the tree picks the right one.
 */
export class Loaders {
  private ready = false;

  constructor(
    private readonly extension: vscode.Uri,
    private readonly storage: vscode.Uri,
  ) {}

  async prepare(): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.storage, 'loaders'));
    for (const kind of KINDS) {
      const source = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extension, 'media', `jury-${kind}.svg`)),
      );
      for (const theme of ['light', 'dark'] as const) {
        await vscode.workspace.fs.writeFile(
          this.file(kind, theme),
          new TextEncoder().encode(source.replaceAll('currentColor', INK[theme])),
        );
      }
    }
    this.ready = true;
  }

  /** The icon for a kind of work, or undefined until the files are written. */
  icon(kind: ActivityKind): { light: vscode.Uri; dark: vscode.Uri } | undefined {
    if (!this.ready) return undefined;
    return { light: this.file(kind, 'light'), dark: this.file(kind, 'dark') };
  }

  private file(kind: ActivityKind, theme: 'light' | 'dark'): vscode.Uri {
    return vscode.Uri.joinPath(this.storage, 'loaders', `jury-${kind}-${theme}.svg`);
  }
}
