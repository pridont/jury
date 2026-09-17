import * as vscode from 'vscode';
import type { FileChange } from '../git/parse.js';
import type { SessionHost } from '../session.js';
import type { Activity, ActivityKind } from './activity.js';
import type { Cohort, Comment, Layer, Risk } from '../model/types.js';

export type Node =
  | { type: 'message'; text: string; icon?: string; loader?: ActivityKind }
  | { type: 'status'; text: string; kind: ActivityKind }
  | { type: 'orphans' }
  | { type: 'orphan'; comment: Comment }
  | { type: 'cohort'; cohort: Cohort; index: number }
  | { type: 'layer'; cohortIndex: number; layerIndex: number; cohort: Cohort; layer: Layer }
  | {
      type: 'layerFile';
      cohortIndex: number;
      layerIndex: number;
      cohort: Cohort;
      layer: Layer;
      path: string;
    };

/**
 * The shape of the review and nothing else: cohorts, and what each is made of.
 * Prose belongs in the tooltip and the walkthrough, where there is room for it.
 */
export class StackTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private activity: Activity | null = null;
  private extension: vscode.Uri | null = null;

  constructor(private readonly host: SessionHost) {
    this.host.onDidChange(() => this.refresh());
  }

  /** Show the running step, with its loading icon, as the first row of the tree. */
  attach(activity: Activity, extension: vscode.Uri): void {
    this.activity = activity;
    this.extension = extension;
    activity.onDidChange(() => this.refresh());
  }

  /**
   * The animated icon for a kind of work, as a light and dark pair the editor picks from.
   *
   * Both are built into `dist/loaders/` at build time and live inside the extension, which
   * is where the activity bar icon is served from too. Copies written somewhere else at
   * runtime — a storage folder, say — add a directory the renderer may decline to serve and
   * a window in which the files do not exist yet.
   */
  private loaderIcon(kind: ActivityKind, fallback: string): { light: vscode.Uri; dark: vscode.Uri } | vscode.ThemeIcon {
    if (!this.extension) return new vscode.ThemeIcon(fallback);
    const file = (theme: 'light' | 'dark') =>
      vscode.Uri.joinPath(this.extension!, 'dist', 'loaders', `jury-${kind}-${theme}.svg`);
    return { light: file('light'), dark: file('dark') };
  }

  refresh(node?: Node): void {
    this.changed.fire(node);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const session = this.host.active;

    switch (node.type) {
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.id = 'message';
        item.contextValue = 'message';
        if (node.loader) item.iconPath = this.loaderIcon(node.loader, node.icon ?? 'loading~spin');
        else if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }

      case 'status': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.id = 'status';
        item.contextValue = 'status';
        item.iconPath = this.loaderIcon(node.kind, 'loading~spin');
        return item;
      }

      case 'cohort': {
        const scaffolding = node.cohort.kind === 'scaffolding';
        // A cohort of one layer says everything its child would. Expanding it to a row that
        // repeats the title is noise, so it becomes that row: openable, tickable, one line.
        const only = node.cohort.layers.length === 1 ? node.cohort.layers[0] : undefined;
        // Becoming that row must not take the row's children with it: a single step spanning
        // files still expands to them, or those files exist nowhere in the tree at all.
        const spans = only !== undefined && only.paths.length > 1;

        const item = new vscode.TreeItem(
          scaffolding ? node.cohort.title : `${node.index + 1}. ${node.cohort.title}`,
          only && !spans
            ? vscode.TreeItemCollapsibleState.None
            : scaffolding
              ? vscode.TreeItemCollapsibleState.Collapsed
              : vscode.TreeItemCollapsibleState.Expanded,
        );

        item.id = `co:${node.cohort.id}`;
        const hunks = node.cohort.layers.reduce((n, layer) => n + layer.hunkIds.length, 0);
        const onlyPath = only?.paths.length === 1 ? only.paths[0] : undefined;
        const files = new Set(node.cohort.layers.flatMap((layer) => layer.paths)).size;
        const where = onlyPath ?? `${files} file${files === 1 ? '' : 's'}`;
        item.description = [
          onlyPath ? statusNote(session, onlyPath) : '',
          where,
          `${hunks} hunk${hunks === 1 ? '' : 's'}`,
        ]
          .filter(Boolean)
          .join(' · ');
        const prose =
          node.cohort.summary || (onlyPath ? (session?.summaries.get(onlyPath) ?? '') : '') || node.cohort.title;
        item.tooltip = new vscode.MarkdownString(
          prose + (node.cohort.riskReason ? `\n\n**Risk:** ${node.cohort.riskReason}` : ''),
        );

        const icon = riskIcon(node.cohort.risk);
        if (icon) item.iconPath = icon;
        item.contextValue = scaffolding ? 'cohort-scaffolding' : 'cohort';

        if (only) {
          if (onlyPath) item.resourceUri = vscode.Uri.file(onlyPath);
          item.checkboxState =
            session && only.hunkIds.every((id) => session.marks.has(id))
              ? vscode.TreeItemCheckboxState.Checked
              : vscode.TreeItemCheckboxState.Unchecked;
          item.command = {
            command: 'jury.openLayer',
            title: 'Open',
            arguments: [node.index, 0],
          };
        }
        return item;
      }

      case 'orphans': {
        const count = session?.comments.filter((comment) => comment.orphaned).length ?? 0;
        const item = new vscode.TreeItem(
          'Notes whose code is gone',
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = 'orphans';
        item.description = `${count}`;
        item.iconPath = new vscode.ThemeIcon('unverified', new vscode.ThemeColor('list.warningForeground'));
        item.tooltip = new vscode.MarkdownString(
          'The code these notes were written about is no longer in the diff. Re-pin one to a hunk, or discard it.',
        );
        item.contextValue = 'orphans';
        return item;
      }

      case 'orphan': {
        const first = node.comment.body.split('\n')[0] ?? '';
        const item = new vscode.TreeItem(first, vscode.TreeItemCollapsibleState.None);
        item.id = `orphan:${node.comment.id}`;
        item.tooltip = new vscode.MarkdownString(node.comment.body);
        item.iconPath = new vscode.ThemeIcon('comment');
        item.contextValue = 'orphan';
        return item;
      }

      case 'layerFile': {
        const item = new vscode.TreeItem(name(node.path), vscode.TreeItemCollapsibleState.None);
        item.id = fileId(node.cohort, node.layer, node.path);
        const hunks = hunksIn(session, node.layer, node.path);
        const notes = session
          ? session.comments.filter((c) => !c.orphaned && hunks.some((id) => id === c.hunkId)).length
          : 0;
        item.description = [
          notes > 0 ? `${notes} note${notes === 1 ? '' : 's'}` : '',
          statusNote(session, node.path),
          directory(node.path),
          `${hunks.length} hunk${hunks.length === 1 ? '' : 's'}`,
        ]
          .filter(Boolean)
          .join(' · ');
        item.resourceUri = vscode.Uri.file(node.path);
        item.tooltip = new vscode.MarkdownString(session?.summaries.get(node.path) ?? node.path);
        item.checkboxState =
          session && hunks.length > 0 && hunks.every((id) => session.marks.has(id))
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
        item.contextValue = 'layerFile';
        item.command = {
          command: 'jury.openLayerFile',
          title: 'Open',
          arguments: [node.cohortIndex, node.layerIndex, node.path],
        };
        return item;
      }

      case 'layer': {
        // A heuristic layer is a file; a model's layer is a step that may span several. Use
        // the paths it recorded rather than reading the title as if it were one.
        const single = node.layer.paths.length === 1 ? node.layer.paths[0] : undefined;
        // The heuristic names a layer after its file, and that row should read as the file.
        // A model's layer is a step, and overwriting "Diff a commit against its first
        // parent" with `source.ts` turns the reading order back into the alphabetical file
        // list this whole thing exists to replace. So the file moves to the description.
        const named = single !== undefined && node.layer.title === single;
        const label = named && single !== undefined ? name(single) : node.layer.title;
        // A step that spans files opens as those files; it also expands to them, so what it
        // touches is visible without opening anything.
        const item = new vscode.TreeItem(
          label,
          single ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = layerId(node.cohort, node.layer);
        const marked = session ? node.layer.hunkIds.every((id) => session.marks.has(id)) : false;
        const notes = session
          ? session.comments.filter((comment) => !comment.orphaned && node.layer.hunkIds.includes(comment.hunkId))
              .length
          : 0;
        const summary = single ? session?.summaries.get(single) : undefined;
        const where = single
          ? named
            ? directory(single)
            : single
          : `${node.layer.paths.length} file${node.layer.paths.length === 1 ? '' : 's'}`;
        // Notes first: in a narrow view the tail is what gets truncated, and "there is
        // something written here" matters more than the hunk count it would push off.
        item.description = [
          notes > 0 ? `${notes} note${notes === 1 ? '' : 's'}` : '',
          single ? statusNote(session, single) : '',
          where,
          `${node.layer.hunkIds.length} hunk${node.layer.hunkIds.length === 1 ? '' : 's'}`,
        ]
          .filter(Boolean)
          .join(' · ');
        // The model's sentence when there is one, the heuristic's description otherwise.
        item.tooltip = new vscode.MarkdownString(node.layer.summary || summary || label);
        if (single) item.resourceUri = vscode.Uri.file(single);
        else item.iconPath = new vscode.ThemeIcon('layers');
        item.checkboxState = marked
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
        item.contextValue = 'layer';
        item.command = {
          command: 'jury.openLayer',
          title: 'Open',
          arguments: [node.cohortIndex, node.layerIndex],
        };
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    const session = this.host.active;
    if (!session) return [];

    if (!node) {
      if (session.error) return [{ type: 'message', text: session.error, icon: 'error' }];
      if (session.loading) {
        return [{ type: 'message', text: `Reading ${session.title}…`, icon: 'loading~spin', loader: 'scanning' }];
      }
      if (session.cohorts.length === 0) return [{ type: 'message', text: 'No changes to review.' }];

      const nodes: Node[] = session.cohorts.map((cohort, index) => ({ type: 'cohort', cohort, index }));
      const running = this.activity?.current;
      if (running) nodes.unshift({ type: 'status', text: running.text, kind: running.kind });
      // Orphaned notes get their own section rather than vanishing with the code they were
      // about. Last, so they never push the reading order down the view.
      if (session.comments.some((comment) => comment.orphaned)) nodes.push({ type: 'orphans' });
      return nodes;
    }

    if (node.type === 'orphans') {
      return session.comments
        .filter((comment) => comment.orphaned)
        .map((comment) => ({ type: 'orphan', comment }) as Node);
    }

    if (node.type === 'layer') {
      if (node.layer.paths.length <= 1) return [];
      return node.layer.paths.map((path) => ({
        type: 'layerFile',
        cohortIndex: node.cohortIndex,
        layerIndex: node.layerIndex,
        cohort: node.cohort,
        layer: node.layer,
        path,
      }));
    }

    if (node.type === 'cohort') {
      const only = node.cohort.layers.length === 1 ? node.cohort.layers[0] : undefined;
      if (only) {
        // The cohort row already says what the layer would, so the layer row is skipped —
        // but its files are rows of their own, hanging off the cohort instead.
        if (only.paths.length <= 1) return [];
        return only.paths.map((path) => ({
          type: 'layerFile',
          cohortIndex: node.index,
          layerIndex: 0,
          cohort: node.cohort,
          layer: only,
          path,
        }));
      }
      return node.cohort.layers.map((layer, layerIndex) => ({
        type: 'layer',
        cohortIndex: node.index,
        layerIndex,
        cohort: node.cohort,
        layer,
      }));
    }

    return [];
  }

  getParent(node: Node): Node | undefined {
    if (node.type === 'layerFile') {
      // When the cohort collapsed to its only layer, the cohort row is the parent. Naming
      // the layer row here would name an element the tree never rendered, and reveal — which
      // walks this chain — would not find the file it was asked to select.
      if (node.cohort.layers.length === 1) {
        return { type: 'cohort', cohort: node.cohort, index: node.cohortIndex };
      }
      return {
        type: 'layer',
        cohortIndex: node.cohortIndex,
        layerIndex: node.layerIndex,
        cohort: node.cohort,
        layer: node.layer,
      };
    }
    if (node.type !== 'layer') return undefined;
    return { type: 'cohort', cohort: node.cohort, index: node.cohortIndex };
  }

  /**
   * The row that stands for a position in the reading order.
   *
   * A step that spans files is selected at the file being read, not at the step: on a step
   * touching twenty files, highlighting the parent says almost nothing about where you are.
   */
  nodeForPosition(cohortIndex: number, layerIndex: number, path: string): Node | undefined {
    const cohort = this.host.active?.cohorts[cohortIndex];
    const layer = cohort?.layers[layerIndex];
    if (!cohort || !layer) return undefined;

    if (layer.paths.length > 1 && layer.paths.includes(path)) {
      return { type: 'layerFile', cohortIndex, layerIndex, cohort, layer, path };
    }
    return { type: 'layer', cohortIndex, layerIndex, cohort, layer };
  }
}

function layerId(cohort: Cohort, layer: Layer): string {
  return `co:${cohort.id}/la:${layer.id}`;
}

function fileId(cohort: Cohort, layer: Layer, path: string): string {
  return `${layerId(cohort, layer)}/f:${path}`;
}

function name(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(at + 1);
}

/**
 * The word that says this row is a file the change removes.
 *
 * Nothing else in the row would: a deletion carries the same file icon and the same hunk
 * count as an edit, and its title in the tree is the name of a file that is no longer there.
 */
function statusNote(session: { files: FileChange[] } | null, path: string): string {
  return session?.files.find((file) => file.path === path)?.status === 'deleted' ? 'deleted' : '';
}

function directory(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/**
 * Risk is not a diagnostic.
 *
 * A red error cross and a yellow warning triangle are what VS Code uses everywhere else to
 * say *this code is broken*, and a reviewer reading that tree would reasonably conclude the
 * extension had found errors. It has not: it is saying "read this one carefully". A flame,
 * in chart colours rather than problem colours, makes that claim instead.
 */
function riskIcon(risk: Risk): vscode.ThemeIcon | undefined {
  switch (risk) {
    case 'low':
      return undefined;
    case 'medium':
      return new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.yellow'));
    case 'high':
      return new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.red'));
  }
}

/** The hunks of one layer that live in one file. */
function hunksIn(
  session: { files: { path: string; hunks: { id: string }[] }[] } | null,
  layer: Layer,
  path: string,
): string[] {
  const file = session?.files.find((candidate) => candidate.path === path);
  if (!file) return [];
  const own = new Set(file.hunks.map((hunk) => hunk.id));
  return layer.hunkIds.filter((id) => own.has(id));
}
