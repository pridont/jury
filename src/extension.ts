import * as path from 'node:path';
import * as vscode from 'vscode';
import { findRepo, currentBranch, type Repo } from './git/repo.js';
import { guardAgainstOrphans, killAll } from './util/exec.js';
import { acquire } from './git/source.js';
import { enrichSymbols } from './enrich.js';
import { doctor, formatChecks } from './doctor.js';
import { Session, SessionHost } from './session.js';
import { StackTree, type Node } from './ui/tree.js';
import { BlobProvider, SCHEME } from './ui/content.js';
import { BlobDefinitions } from './ui/definitions.js';
import { openMultiDiff } from './ui/diff.js';
import { Navigator } from './ui/nav.js';
import { Comments } from './ui/comments.js';
import { reconcileComments } from './model/comments.js';
import { toMarkdown } from './export.js';
import * as providers from './agent/provider.js';
import type { Provider } from './agent/provider.js';
import { ClaudeProvider } from './agent/providers/claude.js';
import { VscodeLmProvider } from './agent/providers/vscodeLm.js';
import { Cache } from './agent/cache.js';
import { Queue } from './agent/queue.js';
import { summariseFiles } from './agent/summaries.js';
import { clusterChange } from './agent/cluster.js';
import { showWalkthrough } from './ui/walkthrough.js';
import { Activity } from './ui/activity.js';
import { forgetSessions, registerChat } from './ui/chat.js';
import { Documents, DOC_SCHEME, offerToSave } from './ui/documents.js';
import { stateDir } from './git/repo.js';
import { buildOrder } from './model/order.js';
import { heuristicCohorts } from './model/heuristic.js';
import { classifyScaffolding } from './model/classify.js';
import type { ReviewSpec } from './model/types.js';
import type { FileChange } from './git/parse.js';
import { load as loadStored, list as listStored, reviewId } from './state/store.js';
import { describeRefresh, reconcileMarks } from './state/reconcile.js';
import { migrateLegacyState } from './state/migrate.js';
import { describeSpec } from './model/types.js';
import { fetchHead, listOpen, resolve, viewedFiles, GhError, type PullRequest } from './github/pr.js';
import { defaultBranch, describeCommit, listRefs, recentCommits, type Ref } from './git/refs.js';
import { pickOrType } from './ui/pick.js';
import { prepare, preview, recordPosted, submit, type ReviewEvent } from './github/submit.js';

let log: vscode.OutputChannel;

/**
 * Which review this window had open, so reloading the window brings it back rather than
 * dropping the reviewer on the welcome screen. Per window, not per repository: opening a
 * second window on the same repo should not inherit what the first one was reading.
 */
let windowState: vscode.Memento;
const LAST_REVIEW = 'jury.lastReview';
/** The same key under the extension's old name, read once so a reload after the rename still restores. */
const LEGACY_LAST_REVIEW = 'changestack.lastReview';

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('Jury');
  windowState = context.workspaceState;

  const host = new SessionHost();
  const tree = new StackTree(host);
  const blobs = new BlobProvider();
  const view = vscode.window.createTreeView('jury.stack', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  const nav = new Navigator(new Session({ root: '', commonDir: '', linkedWorktree: false }, { kind: 'worktree' }));
  const comments = new Comments();
  const claude = new ClaudeProvider();
  const vscodeLm = new VscodeLmProvider();
  providers.register(claude);
  providers.register(vscodeLm);
  const queue = new Queue(4);
  const activity = new Activity();
  tree.attach(activity, context.extensionUri);
  const documents = new Documents();

  context.subscriptions.push(
    log,
    host,
    view,
    nav,
    comments,
    activity,
    { dispose: () => queue.cancelAll() },
    guardAgainstOrphans(),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('jury.providers')) applyProviderSettings(claude, vscodeLm);
    }),

    comments.onDidChange(() => {
      tree.refresh();
      if (host.active) void persist(host.active);
    }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, blobs),
    vscode.languages.registerDefinitionProvider({ scheme: SCHEME }, new BlobDefinitions(host)),
    vscode.workspace.registerTextDocumentContentProvider(DOC_SCHEME, documents),
    documents,

    view.onDidChangeCheckboxState((event) => {
      const session = host.active;
      if (!session) return;
      for (const [node, state] of event.items) {
        // A cohort of one layer is rendered as that layer, so it carries the tick too, and a
        // file row ticks only the hunks of that layer that live in that file.
        const hunkIds =
          node.type === 'layer'
            ? node.layer.hunkIds
            : node.type === 'cohort'
              ? node.cohort.layers.flatMap((layer) => layer.hunkIds)
              : node.type === 'layerFile'
                ? hunksOf(session, node.layer.hunkIds, node.path)
                : [];
        const checked = state === vscode.TreeItemCheckboxState.Checked;
        for (const id of hunkIds) {
          if (checked) session.marks.add(id);
          else session.marks.delete(id);
        }
      }
      updateBadge(view, nav, host);
      void persist(session);
    }),

    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (host.active) nav.syncFromEditor(event.textEditor);
    }),

    vscode.commands.registerCommand('jury.review', () => open(host, { kind: 'worktree' }, ctx())),
    vscode.commands.registerCommand('jury.reviewStaged', () => open(host, { kind: 'staged' }, ctx())),
    vscode.commands.registerCommand('jury.reviewBase', () => reviewBase(host, ctx())),
    vscode.commands.registerCommand('jury.reviewCommit', () => reviewCommit(host, ctx())),
    vscode.commands.registerCommand('jury.reviewPr', () => reviewPr(host, ctx())),
    vscode.commands.registerCommand('jury.submitReview', () => submitReview(host, documents)),
    vscode.commands.registerCommand('jury.refresh', () => refresh(host, ctx())),
    vscode.commands.registerCommand('jury.close', () => {
      // A review that is gone must not leave a subprocess behind talking to the account.
      if (host.active) queue.cancel(host.active.id);
      activity.stop();
      blobs.clear();
      host.close();
      void windowState.update(LAST_REVIEW, undefined);
    }),
    vscode.commands.registerCommand('jury.clearCache', () => clearCache(host)),
    vscode.commands.registerCommand('jury.showLog', () => log.show(true)),
    vscode.commands.registerCommand('jury.resume', () => resume(host, ctx())),
    vscode.commands.registerCommand('jury.list', () => pickReview(host, ctx())),
    vscode.commands.registerCommand('jury.doctor', () => runDoctor()),

    vscode.commands.registerCommand('jury.createComment', (reply: vscode.CommentReply) =>
      comments.add(reply),
    ),
    vscode.commands.registerCommand('jury.editComment', (c: vscode.Comment) => comments.edit(c)),
    vscode.commands.registerCommand('jury.saveComment', (c: vscode.Comment) => comments.save(c)),
    vscode.commands.registerCommand('jury.cancelComment', (c: vscode.Comment) => comments.cancel(c)),
    vscode.commands.registerCommand('jury.deleteComment', (c: vscode.Comment) => comments.remove(c)),
    vscode.commands.registerCommand('jury.repinComment', (node?: Node) => repin(host, comments, node)),
    vscode.commands.registerCommand('jury.discardComment', (node?: Node) => {
      if (node?.type === 'orphan') comments.discard(node.comment);
    }),
    vscode.commands.registerCommand('jury.export', () => exportReview(host, documents)),
    // `isPartialQuery` is the difference between opening the chat with the participant
    // already typed and sending an empty question the moment the key is pressed.
    vscode.commands.registerCommand('jury.ask', () =>
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: '@jury ',
        isPartialQuery: true,
      }),
    ),
    vscode.commands.registerCommand('jury.askStep', () =>
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: '@jury /step ',
        isPartialQuery: true,
      }),
    ),
    vscode.commands.registerCommand('jury.walkthrough', () => {
      if (host.active) void showWalkthrough(host.active, documents);
    }),
    vscode.commands.registerCommand('jury.recluster', () => recluster(host, ctx())),

    vscode.commands.registerCommand('jury.nextHunk', () => nav.next()),
    vscode.commands.registerCommand('jury.prevHunk', () => nav.previous()),
    vscode.commands.registerCommand('jury.nextLayer', () => nav.stepLayer(1)),
    vscode.commands.registerCommand('jury.prevLayer', () => nav.stepLayer(-1)),
    vscode.commands.registerCommand('jury.openLayer', (cohortIndex: number, layerIndex: number) =>
      nav.goToLayer(cohortIndex, layerIndex),
    ),
    vscode.commands.registerCommand(
      'jury.openLayerFile',
      (cohortIndex: number, layerIndex: number, path: string) => nav.goToLayerFile(cohortIndex, layerIndex, path),
    ),
    vscode.commands.registerCommand('jury.openLayerFiles', (node?: Node) => openLayerFiles(host, node)),
    vscode.commands.registerCommand('jury.openCohort', (node?: Node) => openCohort(host, node)),
    vscode.commands.registerCommand('jury.markCohortReviewed', (node?: Node) =>
      markCohort(host, node, ctx()),
    ),
    vscode.commands.registerCommand('jury.toggleReviewed', () => toggleReviewed(host, nav, tree, view)),
    vscode.commands.registerCommand('jury.markLayerReviewed', () => markLayer(host, nav, tree, view)),
    vscode.commands.registerCommand('jury.notScaffolding', (node?: Node) =>
      notScaffolding(host, node, ctx()),
    ),
    vscode.commands.registerCommand('jury.focusMode', () =>
      vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility'),
    ),
  );

  nav.onDidChange((entry) => {
    updateBadge(view, nav, host);
    if (!entry) return;
    const node = tree.nodeForPosition(entry.cohortIndex, entry.layerIndex, entry.file.path);
    // `expand` so a file row inside a collapsed step is actually visible when selected.
    if (node && view.visible) void view.reveal(node, { select: true, focus: false, expand: true });
  });

  context.subscriptions.push(
    registerChat({ host, nav, provider: () => providerFor('ask'), log: (line) => log.appendLine(line) }),
  );

  applyProviderSettings(claude, vscodeLm);
  void vscode.commands.executeCommand('setContext', 'jury.active', false);
  void restoreLast(host, ctx());

  function ctx(): Context {
    return { tree, nav, view, blobs, comments, queue, activity, documents };
  }
}

export function deactivate(): void {
  // Subscriptions are disposed around this, which cancels the queue and takes the children
  // with it. Doing it here as well costs nothing and covers a disposal that does not run.
  killAll();
}

type Context = {
  tree: StackTree;
  nav: Navigator;
  view: vscode.TreeView<Node>;
  blobs: BlobProvider;
  comments: Comments;
  queue: Queue;
  activity: Activity;
  documents: Documents;
};

async function open(host: SessionHost, spec: ReviewSpec, ctx: Context): Promise<void> {
  const repo = await resolveRepo();
  if (!repo) return;

  if (host.active) ctx.queue.cancel(host.active.id);
  ctx.activity.stop();
  ctx.blobs.clear();
  await migrate(repo);
  const session = new Session(repo, spec);

  const stored = await loadStored(repo, reviewId(repo, spec));
  if (stored) {
    session.hydrate(stored);
    log.appendLine(`  resumed ${stored.marks.length} marks from ${new Date(stored.updatedAt).toISOString()}`);
  }

  forgetSessions();
  host.open(session);
  ctx.nav.setSession(session);
  ctx.comments.setSession(session);
  await windowState.update(LAST_REVIEW, spec);
  await load(session, ctx);
}

/** Move state saved under the old name, once, and say so in the log if anything moved. */
async function migrate(repo: Repo): Promise<void> {
  try {
    const { movedState, removedRefs } = await migrateLegacyState(repo);
    if (movedState) log.appendLine(`  carried review state over from the old name in ${repo.root}`);
    if (removedRefs > 0) log.appendLine(`  removed ${removedRefs} pull request refs left under the old name`);
  } catch (error) {
    log.appendLine(`  could not carry old state over: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reopen whatever this window was reviewing when it was last closed.
 *
 * Silent by design: a window that was mid-review should come back mid-review, and a window
 * that was not should see nothing happen. Anything that goes wrong — the repository moved,
 * the branch is gone — leaves the welcome screen rather than an error the reviewer did not
 * ask for.
 */
async function restoreLast(host: SessionHost, ctx: Context): Promise<void> {
  const spec = windowState.get<ReviewSpec>(LAST_REVIEW) ?? windowState.get<ReviewSpec>(LEGACY_LAST_REVIEW);
  if (!spec) return;

  const cwd = workspaceCwd();
  const repo = cwd ? await findRepo(cwd) : null;
  if (!repo) return;
  await migrate(repo);

  const session = new Session(repo, spec);
  const stored = await loadStored(repo, reviewId(repo, spec));
  if (stored) session.hydrate(stored);

  host.open(session);
  ctx.nav.setSession(session);
  ctx.comments.setSession(session);
  await load(session, ctx);
  log.appendLine(`  restored ${describeSpec(spec)} with ${session.marks.size} marks`);
}

/** Reopen the most recently touched review for this repository. */
async function resume(host: SessionHost, ctx: Context): Promise<void> {
  const repo = await resolveRepo();
  if (!repo) return;

  const [latest] = await listStored(repo);
  if (!latest) {
    vscode.window.showInformationMessage('Jury: no saved review for this repository.');
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
    vscode.window.showInformationMessage('Jury: no saved reviews for this repository.');
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

  ctx.queue.cancel(session.id);
  const previous = session.files.flatMap((file) => file.hunks);
  session.clustered = false;
  session.loading = true;
  session.error = null;
  ctx.blobs.clear();
  ctx.tree.refresh();
  await load(session, ctx);
  if (session.error) return;

  const current = session.files.flatMap((file) => file.hunks);
  const { marks, anchors, report } = reconcileMarks(previous, current, session.marks);
  session.marks = marks;

  // Comments take the fuzzy matches marks refuse: losing a note is worse than showing it a
  // couple of lines off, and the flag says not to trust the position.
  const notes = reconcileComments(session.comments, anchors);
  session.comments = notes.comments;
  await persist(session);

  ctx.comments.render();
  ctx.tree.refresh();
  updateBadge(ctx.view, ctx.nav, host);

  if (notes.moved > 0 || notes.orphaned > 0) {
    log.appendLine(`  notes: ${notes.moved} moved, ${notes.orphaned} orphaned`);
  }
  const message = describeRefresh(report);
  log.appendLine(`  ${message}`);
  vscode.window.setStatusBarMessage(`Jury: ${message}`, 6000);
}

/** Persist, and say so plainly if it failed rather than letting a tick be a lie. */
async function persist(session: Session): Promise<void> {
  try {
    await session.persist();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.appendLine(`  could not save review state: ${detail}`);
    vscode.window.showWarningMessage(`Jury: review progress was not saved — ${detail}`);
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
  ctx.comments.render();
  updateBadge(ctx.view, ctx.nav, { active: session } as SessionHost);

  // Best-effort labelling; a missing language server costs a label, never the review.
  await enrichSymbols(session.files, (file) => uriForFile(session, file));
  ctx.tree.refresh();

  void organise(session, ctx);
}

/**
 * Passes 1 and 2, after the review is already usable.
 *
 * The heuristic stack is on screen and navigable before a single request is sent. Summaries
 * arrive one at a time and make it slightly better; clustering arrives once and replaces it.
 * If anything here fails, the review is exactly what it was.
 */
async function organise(session: Session, ctx: Context): Promise<void> {
  const cache = new Cache(path.join(stateDir(session.repo), 'cache'));
  const owner = session.id;
  const write = (line: string) => log.appendLine(line);

  try {
    const summariser = worthSummarising(session) ? await providerFor('summaries') : null;
    if (summariser) await summarise(session, ctx, { provider: summariser, queue: ctx.queue, cache, owner, log: write });

    const clusterer = await providerFor('clustering');
    if (clusterer) await cluster(session, ctx, { provider: clusterer, queue: ctx.queue, cache, owner, log: write });
  } finally {
    ctx.activity.stop();
  }
}

type AgentDeps = Parameters<typeof clusterChange>[0];

/**
 * Pass 2 lands once, and says so.
 *
 * The stack reorganises exactly one time, with an announcement, and never again unasked: a
 * view that rearranges itself under the reader is worse than one that never improves. The
 * hunk being read stays selected across the change.
 */
async function cluster(session: Session, ctx: Context, deps: AgentDeps): Promise<void> {
  if (session.clustered) return;

  ctx.activity.start('Grouping the change', 0, 'deliberating');
  const reading = ctx.nav.current?.hunk.id;
  const result = await clusterChange(deps, session.files, session.summaries);

  if (!result.ok) {
    ctx.activity.stop();
    if (result.reason !== 'cancelled') {
      log.appendLine(`  clustering did not replace the stack: ${result.reason}`);
    }
    return;
  }

  session.cohorts = result.merged.cohorts;
  session.overview = result.merged.summary;
  session.notes = result.merged.notes;
  session.diagram = result.merged.diagram;
  session.clustered = true;
  ctx.activity.stop();

  ctx.nav.setOrder(buildOrder(session.cohorts, session.files));
  ctx.comments.render();
  ctx.tree.refresh();
  updateBadge(ctx.view, ctx.nav, { active: session } as SessionHost);
  if (reading) void ctx.nav.goToHunk(reading);

  const count = session.cohorts.filter((cohort) => cohort.kind !== 'scaffolding').length;
  vscode.window.setStatusBarMessage(
    `Jury: reorganised into ${count} change${count === 1 ? '' : 's'}${result.cached ? ' (cached)' : ''}`,
    6000,
  );

  if (vscode.workspace.getConfiguration('jury').get<boolean>('walkthrough.autoOpen', true)) {
    await showWalkthrough(session, ctx.documents);
  }
}

/** Ask again after a refresh, or when the order looks wrong. */
async function recluster(host: SessionHost, ctx: Context): Promise<void> {
  const session = host.active;
  if (!session) return;

  const provider = await providerFor('clustering');
  if (!provider) return;

  session.clustered = false;
  try {
    await cluster(session, ctx, {
      provider,
      queue: ctx.queue,
      cache: new Cache(path.join(stateDir(session.repo), 'cache')),
      owner: session.id,
      log: (line: string) => log.appendLine(line),
    });
  } finally {
    ctx.activity.stop();
  }
}



/**
 * Whether a change is small enough for per-file summaries to be worth their price.
 *
 * Each is a model call. On a 180-file pull request that is real money and several minutes,
 * and the bigger the change the less of each summary survives into the digest that grouping
 * actually reads — so the cost rises exactly as the benefit falls. Grouping runs either way.
 */
function worthSummarising(session: Session): boolean {
  const limit = vscode.workspace.getConfiguration('jury').get<number>('ai.summariseUpTo', 60);
  const files = session.files.filter(
    (file) => !file.binary && file.hunks.some((hunk) => hunk.kind === 'text' && !hunk.scaffolding),
  ).length;

  if (limit === 0 || files <= limit) return limit !== 0;

  log.appendLine(`  ${files} files is over the summary limit of ${limit}; grouping only`);
  return false;
}

/** Pass 1: a sentence per file, appearing as each lands. */
async function summarise(session: Session, ctx: Context, deps: AgentDeps): Promise<void> {
  const started = Date.now();
  const worth = session.files.filter(
    (file) => !file.binary && file.hunks.some((hunk) => hunk.kind === 'text' && !hunk.scaffolding),
  ).length;
  ctx.activity.start('Reading the change', worth, 'answering');

  const tally = await summariseFiles(deps, session.files, (event) => {
    if (event.kind === 'summary') session.summaries.set(event.path, event.summary);
    ctx.activity.step();
    ctx.tree.refresh();
  });

  log.appendLine(
    `  summaries: ${tally.summarised} written, ${tally.cached} cached, ${tally.failed} failed, ` +
      `$${tally.costUsd.toFixed(4)}, ${Date.now() - started}ms`,
  );
}

/** Say a provider is missing once per window, not once per review. */
let announced = false;
function announceUnavailable(id: string, reason: string | undefined): void {
  if (announced) return;
  announced = true;
  void vscode.window
    .showInformationMessage(
      `Jury: ${id} is unavailable — ${reason ?? 'unknown'}. The review works without it, grouped by file.`,
      'Show log',
    )
    .then((choice) => {
      if (choice === 'Show log') log.show(true);
    });
}

function applyProviderSettings(claude: ClaudeProvider, vscodeLm: VscodeLmProvider): void {
  const settings = vscode.workspace
    .getConfiguration('jury')
    .get<Record<string, { command?: string; models?: Record<string, string> }>>('providers', {});

  const own = settings['claude'];
  if (own?.command) claude.configure({ command: own.command });
  if (own?.models) claude.configure({ models: own.models });

  const lm = settings['vscode-lm'];
  if (lm?.models) vscodeLm.configure({ models: lm.models });
}

/**
 * Which provider answers a given pass.
 *
 * Summaries are many small independent calls and the cheapest thing to send elsewhere;
 * clustering is one call that decides the whole product. Routing them separately is the
 * reason the tiers exist.
 */
async function providerFor(pass: 'summaries' | 'clustering' | 'ask'): Promise<Provider | null> {
  const config = vscode.workspace.getConfiguration('jury');
  if (!config.get<boolean>('ai.enabled', true)) return null;

  const passes = config.get<Record<string, string>>('passes', {});
  const id = passes[pass] ?? config.get<string>('provider', 'claude');
  const provider = providers.get(id);
  if (!provider) {
    log.appendLine(`  no provider called "${id}" is registered`);
    return null;
  }

  const { ok, reason } = await provider.available();
  if (!ok) {
    log.appendLine(`  ${provider.id} unavailable: ${reason ?? 'unknown'}`);
    announceUnavailable(provider.id, reason);
    return null;
  }
  return provider;
}

async function clearCache(host: SessionHost): Promise<void> {
  const repo = host.active?.repo ?? (await resolveRepo());
  if (!repo) return;
  const cache = new Cache(path.join(stateDir(repo), 'cache'));
  const size = await cache.size();
  await cache.clear();
  vscode.window.showInformationMessage(`Jury: cleared ${size} cached answers.`);
}

/** Read the user's settings, then classify. */
async function classify(session: Session): Promise<void> {
  const config = vscode.workspace.getConfiguration('jury');
  await classifyScaffolding(session.repo, session.files, {
    mode: config.get<'collapse' | 'inline' | 'off'>('scaffolding.mode', 'collapse'),
    patterns: config.get<string[]>('scaffolding.patterns', []),
    overrides: session.notScaffolding,
    fromDisk: session.spec.kind === 'worktree',
  });
}

/** The hunks of a layer that live in one file. */
function hunksOf(session: Session, hunkIds: readonly string[], path: string): string[] {
  const file = session.files.find((candidate) => candidate.path === path);
  if (!file) return [];
  const own = new Set(file.hunks.map((hunk) => hunk.id));
  return hunkIds.filter((id) => own.has(id));
}

/** Open every file of one layer together — the cohort action, at the scope of a step. */
async function openLayerFiles(host: SessionHost, node?: Node): Promise<void> {
  const session = host.active;
  if (!session || node?.type !== 'layer') return;

  const files = node.layer.paths
    .map((path) => session.files.find((file) => file.path === path))
    .filter((file): file is FileChange => file !== undefined);
  const multi = await openMultiDiff(session, node.layer.title, files);
  if (!multi) log.appendLine('  multi-file diff editor unavailable; opened files individually');
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

/** Tick every hunk in a cohort, from the tree rather than from the cursor. */
async function markCohort(host: SessionHost, node: Node | undefined, ctx: Context): Promise<void> {
  const session = host.active;
  if (!session || !node || node.type !== 'cohort') return;

  for (const layer of node.cohort.layers) {
    for (const id of layer.hunkIds) session.marks.add(id);
  }
  ctx.tree.refresh();
  updateBadge(ctx.view, ctx.nav, host);
  await persist(session);
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
    vscode.window.showErrorMessage('Jury: open a folder first.');
    return null;
  }
  const repo = await findRepo(cwd);
  if (!repo) {
    vscode.window.showErrorMessage(`Jury: ${cwd} is not inside a git repository.`);
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

  const [refs, commits, trunk, branch] = await Promise.all([
    listRefs(repo),
    recentCommits(repo),
    defaultBranch(repo),
    currentBranch(repo),
  ]);

  // The trunk first, then everything by how recently it moved, then commits. The branch you
  // are standing on is never the answer to "what did this branch add".
  const offered = [
    ...refs.filter((ref) => ref.name === trunk),
    ...refs.filter((ref) => ref.name !== trunk && ref.name !== branch),
    ...commits,
  ];

  const base = await pickOrType<string>({
    title: 'Review this branch',
    placeholder: branch
      ? `What did ${branch} add? Pick a base, or type any revision`
      : 'Pick a base, or type any revision',
    choices: offered.map((ref) => ({
      label: ref.name,
      description: ref.name === trunk ? `${describeRef(ref)} · default` : describeRef(ref),
      detail: ref.subject,
      value: ref.name,
    })),
    fromText: (text) => ({ label: text, value: text }),
  });
  if (!base) return;

  await open(host, { kind: 'range', base, head: 'HEAD', threeDot: true }, ctx);
}

/**
 * Review one commit.
 *
 * Picked from recent commits, or typed: any revision git understands, resolved to the commit
 * it names so the review records the commit rather than the spelling.
 *
 * The commit is chosen in Jury's own view rather than by right-clicking the Source Control
 * graph: `scm/historyItem/context` is a proposed menu, and contributing to it errors for
 * everyone not running with `--enable-proposed-api`.
 */
async function reviewCommit(host: SessionHost, ctx: Context): Promise<void> {
  const repo = await resolveRepo();
  if (!repo) return;

  const rev = await pickCommit(repo);
  if (!rev) return;

  const commit = await describeCommit(repo, rev);
  if (!commit) {
    vscode.window.showErrorMessage(`Jury: ${rev} is not a commit in this repository.`);
    return;
  }

  const spec = commit.subject
    ? ({ kind: 'commit', sha: commit.sha, subject: commit.subject } as const)
    : ({ kind: 'commit', sha: commit.sha } as const);
  await open(host, spec, ctx);
}

async function pickCommit(repo: Repo): Promise<string | undefined> {
  const commits = await recentCommits(repo, 40);
  return pickOrType<string>({
    title: 'Review a commit',
    placeholder: commits.length > 0 ? 'Pick a commit, or type any revision' : 'Type a revision',
    choices: commits.map((ref) => ({
      label: ref.name,
      description: ref.when,
      detail: ref.subject,
      value: ref.name,
    })),
    fromText: (text) => ({ label: text, value: text }),
  });
}

function describeRef(ref: Ref): string {
  const kind =
    ref.kind === 'commit' ? 'commit' : ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'remote' : 'branch';
  return `${kind} · ${ref.when}`;
}

/** Put an orphaned note back on a hunk the reviewer picks out of the reading order. */
async function repin(host: SessionHost, comments: Comments, node?: Node): Promise<void> {
  const session = host.active;
  if (!session || node?.type !== 'orphan') return;

  const choices = session.cohorts.flatMap((cohort) =>
    cohort.layers.flatMap((layer) =>
      layer.hunkIds.map((id) => ({
        label: layer.title,
        description: cohort.title,
        hunkId: id,
      })),
    ),
  );

  const picked = await vscode.window.showQuickPick<(typeof choices)[number]>(choices, {
    title: 'Re-pin this note',
    placeHolder: node.comment.body.split('\n')[0] ?? 'Choose a hunk',
  });
  if (picked) comments.repin(node.comment, picked.hunkId);
}

/** Write the review as markdown and open it, so it can be read before it is sent anywhere. */
async function exportReview(host: SessionHost, documents: Documents): Promise<void> {
  const session = host.active;
  if (!session) return;

  const markdown = toMarkdown({
    spec: session.spec,
    base: session.base,
    head: session.head,
    cohorts: session.cohorts,
    files: session.files,
    comments: session.comments,
    marks: session.marks,
  });

  await documents.show('Review.md', markdown, { preview: false });
  await offerToSave(markdown, 'review.md');
}

/**
 * Review a pull request without checking it out.
 *
 * The head is fetched into a ref of our own and compared against the merge base of its
 * target branch — what the author asked to have merged, not a comparison with whatever that
 * branch has done since. The working tree is not touched.
 */
async function reviewPr(host: SessionHost, ctx: Context): Promise<void> {
  const repo = await resolveRepo();
  if (!repo) return;

  const [open_, branch] = await Promise.all([listOpen(repo), currentBranch(repo)]);

  const number = await pickOrType<number>({
    title: 'Review a pull request',
    placeholder: open_.length > 0 ? 'Pick a pull request, or type a number' : 'Type a pull request number',
    // The one for the branch you are on first, since that is usually the one meant.
    choices: [...open_]
      .sort((a, b) => Number(b.headRef === branch) - Number(a.headRef === branch))
      .map((pull) => ({
        label: `#${pull.number}  ${pull.title}`,
        description: [pull.draft ? 'draft' : '', pull.author, pull.headRef === branch ? 'this branch' : '']
          .filter(Boolean)
          .join(' · '),
        detail: pull.headRef,
        value: pull.number,
      })),
    fromText: (text) =>
      /^#?\d+$/.test(text) ? { label: `#${text.replace('#', '')}`, value: Number(text.replace('#', '')) } : null,
  });
  if (number === undefined) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Jury: fetching the pull request' },
    async () => {
      try {
        const pr = await resolve(repo, number);
        const { base, head } = await fetchHead(repo, pr);
        log.appendLine(`  #${pr.number} ${pr.title} — ${base.slice(0, 12)}..${head.slice(0, 12)}`);

        await open(host, { kind: 'pr', number: pr.number, base, head, title: pr.title }, ctx);

        const session = host.active;
        if (session) {
          session.pr = pr;
          // What GitHub already thinks was read. Marks stay ours — this only starts the
          // review where the reviewer left it on the web.
          const viewed = await viewedFiles(repo, pr);
          for (const file of session.files) {
            if (!viewed.has(file.path)) continue;
            for (const hunk of file.hunks) session.marks.add(hunk.id);
          }
          if (viewed.size > 0) {
            log.appendLine(`  ${viewed.size} files were already marked viewed on GitHub`);
            await persist(session);
            ctx.tree.refresh();
            updateBadge(ctx.view, ctx.nav, host);
          }
        }
      } catch (error) {
        const message = error instanceof GhError ? error.message : String(error);
        vscode.window.showErrorMessage(`Jury: ${message}`);
        log.appendLine(`  pull request review failed: ${message}`);
      }
    },
  );
}

/**
 * Send the review to GitHub, after showing exactly what will be sent.
 *
 * Posting to someone else's repository is not something to do on a keystroke, so the whole
 * payload — every comment, every position, and everything that will *not* be sent — is put
 * in front of the reviewer first.
 */
async function submitReview(host: SessionHost, documents: Documents): Promise<void> {
  const session = host.active;
  if (!session?.pr) {
    vscode.window.showInformationMessage('Jury: open a pull request review first.');
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Comment', detail: 'Leave the notes without approving or blocking', event: 'COMMENT' as ReviewEvent },
      { label: 'Approve', detail: 'Approve the pull request', event: 'APPROVE' as ReviewEvent },
      {
        label: 'Request changes',
        detail: 'Block the pull request until the notes are addressed',
        event: 'REQUEST_CHANGES' as ReviewEvent,
      },
    ],
    { title: `Submit review of #${session.pr.number}`, placeHolder: 'How should this review be submitted?' },
  );
  if (!choice) return;

  const body = await vscode.window.showInputBox({
    title: 'Review summary',
    prompt: 'A sentence or two for the review as a whole. Optional.',
    value: session.overview.split('. ').slice(0, 2).join('. '),
  });
  if (body === undefined) return;

  const hunks = new Map(session.files.flatMap((file) => file.hunks).map((hunk) => [hunk.id, hunk]));
  const submission = prepare(session.comments, hunks, choice.event, body);

  await documents.show(`Review of #${session.pr.number}.md`, preview(session.pr, submission));

  const confirmed = await vscode.window.showWarningMessage(
    `Send this review to ${session.pr.nameWithOwner}#${session.pr.number}?`,
    { modal: true, detail: `${submission.comments.length} inline comments will be posted to GitHub.` },
    'Send',
  );
  if (confirmed !== 'Send') return;

  try {
    const { url, reviewId } = await submit(session.repo, session.pr, submission);

    // Recorded before anything else can go wrong: a note that reached GitHub and is not
    // marked as sent will be sent again, and the author gets two copies of it.
    recordPosted(session.comments, submission, reviewId);
    await persist(session);

    log.appendLine(`  review posted: ${url}`);
    const open = await vscode.window.showInformationMessage('Jury: review posted.', 'Open on GitHub');
    if (open === 'Open on GitHub') await vscode.env.openExternal(vscode.Uri.parse(url));
  } catch (error) {
    const message = error instanceof GhError ? error.message : String(error);
    log.appendLine(`  submitting failed: ${message}`);
    vscode.window.showErrorMessage(`Jury: the review was not posted — ${message}`);
  }
}

async function runDoctor(): Promise<void> {
  const checks = await doctor(workspaceCwd());
  log.clear();
  log.appendLine('Jury — doctor');
  log.appendLine('');
  log.appendLine(formatChecks(checks));
  log.show(true);
}
