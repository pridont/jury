import * as vscode from 'vscode';
import type { SessionHost } from '../session.js';
import type { Cohort, Layer, Risk } from '../model/types.js';

export type Node =
  | { type: 'message'; text: string; icon?: string }
  | { type: 'cohort'; cohort: Cohort; index: number }
  | { type: 'layer'; cohortIndex: number; layerIndex: number; cohort: Cohort; layer: Layer };

/**
 * The shape of the review and nothing else: cohorts, and what each is made of.
 * Prose belongs in the tooltip and the walkthrough, where there is room for it.
 */
export class StackTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly host: SessionHost) {
    this.host.onDidChange(() => this.refresh());
  }

  refresh(node?: Node): void {
    this.changed.fire(node);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const session = this.host.active;

    switch (node.type) {
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'message';
        if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }

      case 'cohort': {
        const scaffolding = node.cohort.kind === 'scaffolding';
        const item = new vscode.TreeItem(
          scaffolding ? node.cohort.title : `${node.index + 1}. ${node.cohort.title}`,
          scaffolding ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
        );
        const hunks = node.cohort.layers.reduce((n, layer) => n + layer.hunkIds.length, 0);
        item.description = `${node.cohort.kind} · ${hunks} hunk${hunks === 1 ? '' : 's'}`;
        item.tooltip = new vscode.MarkdownString(
          node.cohort.summary + (node.cohort.riskReason ? `\n\n**Risk:** ${node.cohort.riskReason}` : ''),
        );
        const icon = riskIcon(node.cohort.risk);
        if (icon) item.iconPath = icon;
        item.contextValue = scaffolding ? 'cohort-scaffolding' : 'cohort';
        return item;
      }

      case 'layer': {
        const item = new vscode.TreeItem(node.layer.title, vscode.TreeItemCollapsibleState.None);
        const marked = session ? node.layer.hunkIds.every((id) => session.marks.has(id)) : false;
        item.description = `${node.layer.hunkIds.length} hunk${node.layer.hunkIds.length === 1 ? '' : 's'}`;
        item.tooltip = new vscode.MarkdownString(node.layer.summary);
        item.resourceUri = vscode.Uri.file(node.layer.title);
        item.checkboxState = marked
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
        item.contextValue = 'layer';
        item.command = {
          command: 'changestack.openLayer',
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
      if (session.loading) return [{ type: 'message', text: `Reading ${session.title}…`, icon: 'loading~spin' }];
      if (session.cohorts.length === 0) return [{ type: 'message', text: 'No changes to review.' }];
      return session.cohorts.map((cohort, index) => ({ type: 'cohort', cohort, index }));
    }

    if (node.type === 'cohort') {
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
    if (node.type !== 'layer') return undefined;
    return { type: 'cohort', cohort: node.cohort, index: node.cohortIndex };
  }

  /** The tree node for a position in the reading order, so navigation can select it. */
  nodeForLayer(cohortIndex: number, layerIndex: number): Node | undefined {
    const cohort = this.host.active?.cohorts[cohortIndex];
    const layer = cohort?.layers[layerIndex];
    if (!cohort || !layer) return undefined;
    return { type: 'layer', cohortIndex, layerIndex, cohort, layer };
  }
}

function riskIcon(risk: Risk): vscode.ThemeIcon | undefined {
  switch (risk) {
    case 'low':
      return undefined;
    case 'medium':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    case 'high':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
  }
}
