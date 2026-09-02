import * as path from 'node:path';
import * as vscode from 'vscode';
import { findRepo, currentBranch, type Repo } from './git/repo.js';
import { acquire } from './git/source.js';
import { enrichSymbols } from './enrich.js';
import { doctor, formatChecks } from './doctor.js';
import { Session, SessionHost } from './session.js';
import { StackTree, type Node } from './ui/tree.js';
import { BlobProvider, SCHEME } from './ui/content.js';
import { openMultiDiff } from './ui/diff.js';
import { Navigator } from './ui/nav.js';
import { buildOrder } from './model/order.js';
import { heuristicCohorts } from './model/heuristic.js';
import { classifyScaffolding } from './model/classify.js';
import type { ReviewSpec } from './model/types.js';
import type { FileChange } from './git/parse.js';
import { load as loadStored, list as listStored, reviewId } from './state/store.js';
import { describeRefresh, reconcileMarks } from './state/reconcile.js';
import { describeSpec } from './model/types.js';

let log: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('Change Stack');

  const host = new SessionHost();
  const tree = new StackTree(host);
  const blobs = new BlobProvider();
  const view = vscode.window.createTreeView('changestack.stack', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  const nav = new Navigator(new Session({ root: '', commonDir: '', linkedWorktree: false }, { kind: 'worktree' }));

  context.subscriptions.push(
    log,
    host,
    view,
    nav,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, blobs),

    view.onDidChangeCheckboxState((event) => {
      for (const [node, state] of event.items) {
        if (node.type !== 'layer') continue;
        const session = host.active;
        if (!session) continue;
        const checked = state === vscode.TreeItemCheckboxState.Checked;
        for (const id of node.layer.hunkIds) {
          if (checked) session.marks.add(id);
          else session.marks.delete(id);
        }
      }
      updateBadge(view, nav, host);
      if (host.active) void persist(host.active);
    }),

    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (host.active) nav.syncFromEditor(event.textEditor);
    }),

    vscode.commands.registerCommand('changestack.review', () => open(host, { kind: 'worktree' }, ctx())),
    vscode.commands.registerCommand('changestack.reviewStaged', () => open(host, { kind: 'staged' }, ctx())),
    vscode.commands.registerCommand('changestack.reviewBase', () => reviewBase(host, ctx())),
    vscode.commands.registerCommand('changestack.refresh', () => refresh(host, ctx())),
    vscode.commands.registerCommand('changestack.close', () => {
      blobs.clear();
      host.close();
    }),
    vscode.commands.registerCommand('changestack.resume', () => resume(host, ctx())),
    vscode.commands.registerCommand('changestack.list', () => pickReview(host, ctx())),
    vscode.commands.registerCommand('changestack.doctor', () => runDoctor()),

    vscode.commands.registerCommand('changestack.nextHunk', () => nav.next()),
    vscode.commands.registerCommand('changestack.prevHunk', () => nav.previous()),
    vscode.commands.registerCommand('changestack.nextLayer', () => nav.stepLayer(1)),
    vscode.commands.registerCommand('changestack.prevLayer', () => nav.stepLayer(-1)),
    vscode.commands.registerCommand('changestack.openLayer', (cohortIndex: number, layerIndex: number) =>
      nav.goToLayer(cohortIndex, layerIndex),
    ),
    vscode.commands.registerCommand('changestack.openCohort', (node?: Node) => openCohort(host, node)),
    vscode.commands.registerCommand('changestack.toggleReviewed', () => toggleReviewed(host, nav, tree, view)),
    vscode.commands.registerCommand('changestack.markLayerReviewed', () => markLayer(host, nav, tree, view)),
    vscode.commands.registerCommand('changestack.notScaffolding', (node?: Node) =>
      notScaffolding(host, node, ctx()),
    ),
    vscode.commands.registerCommand('changestack.focusMode', () =>
      vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility'),
    ),
  );

  nav.onDidChange((entry) => {
    updateBadge(view, nav, host);
    if (!entry) return;
    const node = tree.nodeForLayer(entry.cohortIndex, entry.layerIndex);
    if (node && view.visible) void view.reveal(node, { select: true, focus: false });
  });

  void vscode.commands.executeCommand('setContext', 'changestack.active', false);

  function ctx(): Context {
    return { tree, nav, view, blobs };
  }
}

export function deactivate(): void {
  // Everything a review allocates is owned by the session, which the context disposes.
}

type Context = { tree: StackTree; nav: Navigator; view: vscode.TreeView<Node>; blobs: BlobProvider };

async function open(host: SessionHost, spec: ReviewSpec, ctx: Context): Promise<void> {
  const repo = await resolveRepo();
  if (!repo) return;

  ctx.blobs.clear();
  const session = new Session(repo, spec);

  const stored = await loadStored(repo, reviewId(repo, spec));
  if (stored) {
    session.hydrate(stored);
    log.appendLine(`  resumed ${stored.marks.length} marks from ${new Date(stored.updatedAt).toISOString()}`);
  }

  host.open(session);
  ctx.nav.setSession(session);
  await load(session, ctx);
}

/** Reopen the most recently touched review for this repository. */
async function resume(host: SessionHost, ctx: Context): Promise<void> {
  const repo = await resolveRepo();
  if (!repo) return;

  const [latest] = await listStored(repo);
  if (!latest) {
    vscode.window.showInformationMessage('Change Stack: no saved review for this repository.');
    return;
  }
  await open(host, latest.spec, ctx);
}

/** Pick from the saved reviews for this repository. */
async function pickReview(host: SessionHost, ctx: Context): Promise<void> {
  const repo = await resolveRepo();
  if (!repo) return;

  const saved = await listStored(repo);
  if (saved.length === 0) {
    vscode.window.showInformationMessage('Change Stack: no saved reviews for this repository.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    saved.map((review) => ({
      label: describeSpec(review.spec),
      description: `${review.marks.length} marked`,
      detail: `last opened ${new Date(review.updatedAt).toLocaleString()}`,
      review,
    })),
    { title: 'Saved reviews', placeHolder: 'Reopen a review' },
  );
  if (picked) await open(host, picked.review.spec, ctx);
}

async function refresh(host: SessionHost, ctx: Context): Promise<void> {
  const session = host.active;
  if (!session) return;

  const previous = session.files.flatMap((file) => file.hunks);
  session.loading = true;
  session.error = null;
  ctx.blobs.clear();
  ctx.tree.refresh();
  await load(session, ctx);
  if (session.error) return;

  const current = session.files.flatMap((file) => file.hunks);
  const { marks, report } = reconcileMarks(previous, current, session.marks);
  session.marks = marks;
  await persist(session);

  ctx.tree.refresh();
  updateBadge(ctx.view, ctx.nav, host);

  const message = describeRefresh(report);
  log.appendLine(`  ${message}`);
  vscode.window.setStatusBarMessage(`Change Stack: ${message}`, 6000);
}

/** Persist, and say so plainly if it failed rather than letting a tick be a lie. */
async function persist(session: Session): Promise<void> {
  try {
    await session.persist();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.appendLine(`  could not save review state: ${detail}`);
    vscode.window.showWarningMessage(`Change Stack: review progress was not saved — ${detail}`);
  }
}

/**
 * Acquire, classify, group, and put the reading order in front of the reviewer.
 *
 * Failure is reported in the tree and the log, never as an empty review: "nothing changed"
 * and "we could not read it" must not look alike.
 */
async function load(session: Session, ctx: Context): Promise<void> {
  const started = Date.now();
  log.appendLine(`[${new Date().toISOString()}] reading ${session.title} in ${session.repo.root}`);

  try {
    const acquired = await acquire(session.repo, session.spec);
    session.base = acquired.base;
    session.head = acquired.head;
    session.files = acquired.files;
    session.error = null;

    await classify(session);
    session.cohorts = heuristicCohorts(session.files);

    const scaffolding = session.files.filter((f) => f.hunks.some((h) => h.scaffolding)).length;
    log.appendLine(
      `  ${acquired.files.length} files, ${session.hunkCount} hunks, ` +
        `${session.cohorts.length} cohorts, ${scaffolding} scaffolding, in ${Date.now() - started}ms`,
    );
  } catch (error) {
    session.files = [];
    session.cohorts = [];
    session.error = error instanceof Error ? error.message : String(error);
    log.appendLine(`  failed: ${session.error}`);
  } finally {
    session.loading = false;
    ctx.tree.refresh();
  }

  if (session.error) return;

  ctx.nav.setOrder(buildOrder(session.cohorts, session.files));
  updateBadge(ctx.view, ctx.nav, { active: session } as SessionHost);

  // Best-effort labelling; a missing language server costs a label, never the review.
  await enrichSymbols(session.files, (file) => uriForFile(session, file));
  ctx.tree.refresh();
}

/** Read the user's settings, then classify. */
async function classify(session: Session): Promise<void> {
  const config = vscode.workspace.getConfiguration('changestack');
  await classifyScaffolding(session.repo, session.files, {
    mode: config.get<'collapse' | 'inline' | 'off'>('scaffolding.mode', 'collapse'),
    patterns: config.get<string[]>('scaffolding.patterns', []),
    overrides: session.notScaffolding,
    fromDisk: session.spec.kind === 'worktree',
  });
}

async function openCohort(host: SessionHost, node?: Node): Promise<void> {
  const session = host.active;
  if (!session || !node || node.type !== 'cohort') return;

  const paths = new Set(
    node.cohort.layers.flatMap((layer) =>
      layer.hunkIds.map((id) => session.files.find((file) => file.hunks.some((h) => h.id === id))?.path ?? ''),
    ),
  );
  const files = session.files.filter((file) => paths.has(file.path));
  const multi = await openMultiDiff(session, node.cohort.title, files);
  if (!multi) log.appendLine('  multi-file diff editor unavailable; opened files individually');
}

function toggleReviewed(host: SessionHost, nav: Navigator, tree: StackTree, view: vscode.TreeView<Node>): void {
  const session = host.active;
  const entry = nav.current;
  if (!session || !entry) return;

  if (session.marks.has(entry.hunk.id)) session.marks.delete(entry.hunk.id);
  else session.marks.add(entry.hunk.id);
  tree.refresh();
  updateBadge(view, nav, host);
  void persist(session);
}

async function markLayer(
  host: SessionHost,
  nav: Navigator,
  tree: StackTree,
  view: vscode.TreeView<Node>,
): Promise<void> {
  const session = host.active;
  const entry = nav.current;
  if (!session || !entry) return;

  for (const id of entry.layer.hunkIds) session.marks.add(id);
  tree.refresh();
  updateBadge(view, nav, host);
  await persist(session);
  await nav.stepLayer(1);
}

/**
 * Teach the tool, once, that this repository means it. Remembered for the session now and
 * on disk with the rest of the review state.
 */
async function notScaffolding(host: SessionHost, node: Node | undefined, ctx: Context): Promise<void> {
  const session = host.active;
  if (!session || !node) return;

  const paths =
    node.type === 'layer' ? [node.layer.title] : node.type === 'cohort' ? node.cohort.layers.map((l) => l.title) : [];
  for (const path of paths) session.notScaffolding.add(path);
  await persist(session);

  await classify(session);
  session.cohorts = heuristicCohorts(session.files);
  ctx.nav.setOrder(buildOrder(session.cohorts, session.files));
  ctx.tree.refresh();
}

function updateBadge(view: vscode.TreeView<Node>, nav: Navigator, host: SessionHost): void {
  if (!host.active) {
    view.badge = undefined;
    view.description = '';
    return;
  }
  const { reviewed, total } = nav.progress;
  view.description = total > 0 ? `${reviewed}/${total} reviewed` : '';
  view.badge = total - reviewed > 0 ? { value: total - reviewed, tooltip: `${total - reviewed} hunks to read` } : undefined;
}

/**
 * Resolve the repository for the active editor, falling back to the first workspace folder.
 * Returns null after telling the user why — "not a git repository" is one clean message,
 * never a partial UI.
 */
async function resolveRepo(): Promise<Repo | null> {
  const cwd = workspaceCwd();
  if (!cwd) {
    vscode.window.showErrorMessage('Change Stack: open a folder first.');
    return null;
  }
  const repo = await findRepo(cwd);
  if (!repo) {
    vscode.window.showErrorMessage(`Change Stack: ${cwd} is not inside a git repository.`);
    return null;
  }
  return repo;
}

function workspaceCwd(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') {
    return vscode.workspace.getWorkspaceFolder(active)?.uri.fsPath ?? undefined;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Where the new side of a file lives. For a worktree review that is the real file, so a
 * language server is already attached to it.
 */
function uriForFile(session: Session, file: FileChange): vscode.Uri | null {
  if (session.spec.kind !== 'worktree') return null;
  if (file.status === 'deleted' || file.binary) return null;
  return vscode.Uri.file(path.join(session.repo.root, file.path));
}

async function reviewBase(host: SessionHost, ctx: Context): Promise<void> {
  const repo = await resolveRepo();
  if (!repo) return;

  const branch = await currentBranch(repo);
  const base = await vscode.window.showInputBox({
    title: 'Review this branch',
    prompt: 'Review what this branch introduced, against which base?',
    value: 'main',
    placeHolder: branch ? `merge-base of main and ${branch}` : 'main',
  });
  if (!base) return;

  await open(host, { kind: 'range', base, head: 'HEAD', threeDot: true }, ctx);
}

async function runDoctor(): Promise<void> {
  const checks = await doctor(workspaceCwd());
  log.clear();
  log.appendLine('Change Stack — doctor');
  log.appendLine('');
  log.appendLine(formatChecks(checks));
  log.show(true);
}
