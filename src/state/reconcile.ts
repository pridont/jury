import type { Hunk } from '../model/types.js';
import { reanchor, type Anchor } from './anchor.js';

export type RefreshReport = {
  /** Marked hunks that came back untouched. */
  kept: number;
  /** Marked hunks whose own content changed, and so came back unreviewed. */
  changed: number;
  /** Marked hunks that are no longer in the diff at all. */
  gone: number;
};

export type Reconciled = {
  marks: Set<string>;
  /**
   * Hunks of the new diff with no exact match in the old one: new, or edited since. A moved
   * match counts — its content is not what was read, which is the same reason it loses its
   * mark.
   */
  changed: Set<string>;
  anchors: Map<string, Anchor>;
  report: RefreshReport;
};

/**
 * Carry review progress across a re-diff.
 *
 * A mark is only carried by an exact content match. A hunk that changed comes back
 * unreviewed however similar it looks, because a tick that survives an edit is a lie, and a
 * lie about what has been reviewed is worse than having no marks at all. Comments are the
 * opposite trade and take moved matches too — losing the note entirely is worse than showing
 * it a couple of lines off — which is why this returns the anchors rather than only the
 * marks.
 */
export function reconcileMarks(
  previous: readonly Hunk[],
  current: readonly Hunk[],
  marks: ReadonlySet<string>,
): Reconciled {
  const anchors = reanchor(previous, current);
  const carried = new Set<string>();
  const report: RefreshReport = { kept: 0, changed: 0, gone: 0 };

  for (const id of marks) {
    const anchor = anchors.get(id);
    if (!anchor) {
      // The mark belongs to a hunk this refresh never saw before — a stale entry from an
      // older state file. Drop it quietly rather than counting it as a loss.
      continue;
    }
    if (anchor.kind === 'exact') {
      carried.add(anchor.hunkId);
      report.kept += 1;
    } else if (anchor.kind === 'moved') {
      report.changed += 1;
    } else {
      report.gone += 1;
    }
  }

  const changed = new Set(current.filter((hunk) => anchors.get(hunk.id)?.kind !== 'exact').map((hunk) => hunk.id));
  return { marks: carried, changed, anchors, report };
}

/** `changed` is the count of hunks that are new or edited, marked or not. */
export function describeRefresh(report: RefreshReport, changed: number): string {
  const parts = [
    `${changed} hunk${changed === 1 ? '' : 's'} new or changed`,
    `${report.kept} mark${report.kept === 1 ? '' : 's'} kept`,
  ];
  if (report.changed > 0) parts.push(`${report.changed} changed`);
  if (report.gone > 0) parts.push(`${report.gone} gone`);
  return `refreshed · ${parts.join(' · ')}`;
}
