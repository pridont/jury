/**
 * What an end-to-end test drives Jury with. Everything here acts on the real extension, in a
 * real VS Code window, on a real git repository; only the model is fake.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Api } from '../../src/extension.js';
import type { Node } from '../../src/ui/tree.js';

/** The extension's live objects: `host.active` is the open review, `nav.current` the hunk on screen. */
export async function jury(): Promise<Api> {
  const extension = vscode.extensions.getExtension<Api>('pridont.jury');
  if (!extension) throw new Error('the extension under test is not loaded');
  return extension.activate();
}

/** The repository the window has open. */
export const repo = {
  root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',

  /**
   * Start over: close any review, wipe history and saved review state, and commit `files` as
   * the first commit. Call it at the start of every test.
   */
  async reset(files: Record<string, string> = { 'README.md': '# fixture\n' }): Promise<void> {
    await vscode.commands.executeCommand('jury.close');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const entry of fs.readdirSync(this.root)) {
      if (entry !== '.vscode') fs.rmSync(path.join(this.root, entry), { recursive: true, force: true });
    }
    this.git('init', '-q', '-b', 'main');
    fs.appendFileSync(path.join(this.root, '.git', 'info', 'exclude'), '.vscode/\n');
    this.write(files);
    this.commit('initial');
  },

  write(files: Record<string, string>): void {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(this.root, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  },

  remove(...files: string[]): void {
    for (const file of files) fs.rmSync(path.join(this.root, file), { force: true });
  },

  git(...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: this.root,
      encoding: 'utf8',
    });
  },

  commit(message: string): void {
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
  },
};

/** The fake `claude` CLI: script its answers, read back what it was asked. */
export const fake = {
  dir: process.env.JURY_FAKE_DIR ?? '',

  /** Answer any call whose system prompt or input matches `match` with `reply`. First match wins. */
  reply(match: string, reply: string): void {
    const file = path.join(this.dir, 'replies.json');
    const replies = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[]) : [];
    fs.writeFileSync(file, JSON.stringify([...replies, { match, reply }]));
  },

  calls(): { args: string[]; system: string; input: string }[] {
    const file = path.join(this.dir, 'calls.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; system: string; input: string });
  },

  reset(): void {
    fs.rmSync(path.join(this.dir, 'replies.json'), { force: true });
    fs.rmSync(path.join(this.dir, 'calls.jsonl'), { force: true });
  },
};

/** Poll until `check` returns something truthy, and return it. */
export async function waitFor<T>(check: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

/**
 * Open a review and wait until it is loaded. `command` is any of the `jury.review*` commands
 * that need no input. With `clustered`, also wait for the model's grouping to land.
 */
export async function review(command = 'jury.review', options: { clustered?: boolean } = {}): Promise<Api> {
  const api = await jury();
  await vscode.commands.executeCommand(command);
  await waitFor(() => api.host.active && !api.host.active.loading, 'the review to load');
  if (options.clustered) await waitFor(() => api.host.active?.clustered, 'the model grouping to land');
  return api;
}

/**
 * The Jury sidebar as text, one row per line, indented by depth — what a reviewer sees.
 * `[x]`/`[ ]` is the reviewed checkbox; the part after `—` is the row's grey description.
 */
export async function sidebar(): Promise<string> {
  const { tree } = await jury();
  const lines: string[] = [];
  const walk = (node: Node | undefined, depth: number) => {
    for (const child of tree.getChildren(node)) {
      const item = tree.getTreeItem(child);
      const label = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
      const box =
        item.checkboxState === undefined
          ? ''
          : (typeof item.checkboxState === 'object' ? item.checkboxState.state : item.checkboxState) ===
              vscode.TreeItemCheckboxState.Checked
            ? '[x] '
            : '[ ] ';
      const description = typeof item.description === 'string' && item.description ? ` — ${item.description}` : '';
      lines.push(`${'  '.repeat(depth)}${box}${label}${description}`);
      if (item.collapsibleState !== vscode.TreeItemCollapsibleState.None) walk(child, depth + 1);
    }
  };
  walk(undefined, 0);
  return lines.join('\n');
}

/** Leave a note on `line` (1-based, new side) of `file`, the way the comment gutter does. */
export async function addNote(file: string, line: number, text: string): Promise<void> {
  const thread = {
    uri: vscode.Uri.file(path.join(repo.root, file)),
    range: new vscode.Range(line - 1, 0, line - 1, 0),
    comments: [] as readonly vscode.Comment[],
    collapsibleState: vscode.CommentThreadCollapsibleState.Collapsed,
    dispose: () => {},
  };
  await vscode.commands.executeCommand('jury.createComment', { thread, text });
}

/**
 * Answer the quick pick a command just opened by choosing item `index` (0 = top). Start the
 * command with `void`, not `await`: it does not finish until the pick is answered. Typing a
 * value into the picker cannot be scripted; only listed items can be chosen.
 */
export async function pick(index = 0): Promise<void> {
  // ponytail: fixed wait for the picker to open; the API has no "quick pick is showing" signal.
  await new Promise((resolve) => setTimeout(resolve, 800));
  for (let i = 0; i < index; i++) await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
}

/** The text of the active editor, or of the open untitled/virtual document named `name`. */
export function documentText(name?: string): string {
  if (!name) return vscode.window.activeTextEditor?.document.getText() ?? '';
  const doc = vscode.workspace.textDocuments.find((d) => path.basename(d.uri.path) === name);
  return doc?.getText() ?? '';
}
