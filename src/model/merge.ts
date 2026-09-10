import type { Cohort, CohortKind, Hunk, Layer, Risk } from './types.js';

/** What pass 2 is contracted to return. Nothing here is trusted until `merge` has run. */
export type ClusterOutput = {
  summary?: unknown;
  cohorts?: unknown;
  notes?: unknown;
  diagram?: unknown;
};

export type Merged = {
  cohorts: Cohort[];
  summary: string;
  notes: string[];
  /** Mermaid source, when the model judged the change had a shape worth drawing. */
  diagram: string;
};

export type MergeResult = { ok: true; merged: Merged } | { ok: false; reason: string };

const KINDS: readonly CohortKind[] = [
  'feature',
  'fix',
  'refactor',
  'plumbing',
  'test',
  'config',
  'docs',
  'generated',
];

const RISKS: readonly Risk[] = ['low', 'medium', 'high'];

/** Cohorts of these kinds go last, whatever order the model asked for. */
const TAIL: readonly CohortKind[] = ['docs', 'generated'];

/**
 * Turn model output into a stack, or decline it.
 *
 * The model proposes; this disposes. Any output, however malformed, must produce a complete
 * and correct partition of the hunk set — every hunk in exactly one place — or no stack at
 * all. Nothing downstream is allowed to discover that a hunk went missing.
 */
export function merge(
  output: ClusterOutput,
  labels: ReadonlyMap<string, Hunk>,
  scaffolding: readonly Hunk[] = [],
): MergeResult {
  const raw = Array.isArray(output.cohorts) ? output.cohorts : [];
  if (raw.length === 0) return { ok: false, reason: 'no cohorts were returned' };

  const claimed = new Set<string>();
  const cohorts: Cohort[] = [];

  raw.forEach((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null) return;
    const record = candidate as Record<string, unknown>;

    const layers: Layer[] = [];
    const rawLayers = Array.isArray(record['layers']) ? record['layers'] : [];

    rawLayers.forEach((rawLayer, layerIndex) => {
      if (typeof rawLayer !== 'object' || rawLayer === null) return;
      const layerRecord = rawLayer as Record<string, unknown>;

      const hunkIds: string[] = [];
      const rawHunks = Array.isArray(layerRecord['hunks']) ? layerRecord['hunks'] : [];
      for (const label of rawHunks) {
        if (typeof label !== 'string') continue;
        const hunk = labels.get(label.trim());
        // An invented label is dropped; a repeated one keeps its first home.
        if (!hunk || claimed.has(hunk.id)) continue;
        claimed.add(hunk.id);
        hunkIds.push(hunk.id);
      }

      if (hunkIds.length === 0) return;
      layers.push({
        id: `c${index + 1}l${layerIndex + 1}`,
        title: text(layerRecord['title']) || 'Changes',
        summary: text(layerRecord['summary']),
        hunkIds,
        paths: pathsOf(hunkIds, labels),
      });
    });

    if (layers.length === 0) return;

    const cohort: Cohort = {
      id: `c${index + 1}`,
      title: text(record['title']) || 'Changes',
      summary: text(record['summary']),
      kind: oneOf<CohortKind, 'change'>(record['kind'], KINDS, 'change'),
      risk: oneOf<Risk, 'low'>(record['risk'], RISKS, 'low'),
      layers,
      origin: 'ai',
    };
    const reason = text(record['riskReason'] ?? record['risk_reason']);
    if (cohort.risk !== 'low' && reason) cohort.riskReason = reason;
    cohorts.push(cohort);
  });

  if (cohorts.length === 0) return { ok: false, reason: 'every cohort was empty once checked' };

  // Whatever the model failed to place still has to be reviewable.
  const missing = [...labels.values()].filter((hunk) => !claimed.has(hunk.id));
  const placed = claimed.size;
  const total = labels.size;

  if (placed / Math.max(total, 1) < 0.6) {
    return { ok: false, reason: `only ${placed} of ${total} hunks were placed` };
  }

  const verdict = organised(cohorts, labels, total);
  if (verdict) return { ok: false, reason: verdict };

  if (missing.length > 0) {
    cohorts.push({
      id: 'c-unclassified',
      title: 'Unclassified',
      summary: 'The model did not place these; they are here so nothing goes unread.',
      kind: 'unclassified',
      risk: 'low',
      layers: [
        {
          id: 'c-unclassified-l1',
          title: 'Unplaced changes',
          summary: '',
          hunkIds: missing.map((hunk) => hunk.id),
          paths: [...new Set(missing.map((hunk) => hunk.path))],
        },
      ],
      origin: 'ai',
    });
  }

  // Exactly one stable post-pass over the model's order: a lockfile is never cohort #1,
  // whatever the model thinks.
  const tail = cohorts.filter((cohort) => TAIL.includes(cohort.kind));
  const head = cohorts.filter((cohort) => !TAIL.includes(cohort.kind));
  const ordered = [...head, ...tail];

  if (scaffolding.length > 0) {
    ordered.push(scaffoldingCohort(scaffolding));
  }

  const names = pathNames(labels);
  for (const cohort of ordered) {
    cohort.title = unlabel(cohort.title, names);
    cohort.summary = unlabel(cohort.summary, names);
    if (cohort.riskReason) cohort.riskReason = unlabel(cohort.riskReason, names);
    for (const layer of cohort.layers) {
      layer.title = unlabel(layer.title, names);
      layer.summary = unlabel(layer.summary, names);
    }
  }

  return {
    ok: true,
    merged: {
      cohorts: ordered,
      summary: unlabel(text(output.summary), names),
      notes: (Array.isArray(output.notes) ? output.notes : [])
        .filter((note): note is string => typeof note === 'string')
        .map((note) => unlabel(note, names)),
      diagram: diagramOf(output.diagram),
    },
  };
}

/**
 * Whether this is organisation at all.
 *
 * One cohort for everything parses perfectly and organises nothing; so does one cohort per
 * file, which is what the reviewer already had. Both are declined, and the heuristic stack
 * stays — a wrong answer that looks like an answer is worse than no answer.
 */
function organised(cohorts: readonly Cohort[], labels: ReadonlyMap<string, Hunk>, total: number): string | null {
  if (cohorts.length === 1 && total > 3) return 'everything was put in one cohort';

  const files = new Set([...labels.values()].map((hunk) => hunk.path)).size;
  if (files > 5 && cohorts.length >= files) {
    const perFile = cohorts.every((cohort) => new Set(cohort.layers.flatMap((layer) => layer.paths)).size <= 1);
    if (perFile) return 'one cohort per file is the grouping the reviewer already had';
  }
  return null;
}

function scaffoldingCohort(hunks: readonly Hunk[]): Cohort {
  const paths = [...new Set(hunks.map((hunk) => hunk.path))];
  const reasons = [...new Set(hunks.map((hunk) => hunk.scaffolding?.reason).filter(Boolean))];
  return {
    id: 'c-scaffolding',
    title: `Scaffolding · ${paths.length} file${paths.length === 1 ? '' : 's'}`,
    summary: `Generated or vendored: ${reasons.join(', ')}. Not in the reading order.`,
    kind: 'scaffolding',
    risk: 'low',
    layers: paths.map((path, index) => ({
      id: `c-scaffolding-l${index + 1}`,
      title: path,
      summary: hunks.find((hunk) => hunk.path === path)?.scaffolding?.reason ?? 'generated',
      hunkIds: hunks.filter((hunk) => hunk.path === path).map((hunk) => hunk.id),
      paths: [path],
    })),
    origin: 'heuristic',
  };
}

/**
 * Labels are how the model refers to hunks and nowhere else.
 *
 * A title that says "h6 is unrelated to the rest" is meaningless to the person reading it,
 * so every label that leaks into prose is replaced by the file it stands for.
 */
export function unlabel(value: string, names: ReadonlyMap<string, string>): string {
  return value.replace(/\bh(\d+)\b/g, (match, digits: string) => names.get(`h${digits}`) ?? match);
}

function pathNames(labels: ReadonlyMap<string, Hunk>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [label, hunk] of labels) names.set(label, hunk.path);
  return names;
}

function pathsOf(hunkIds: readonly string[], labels: ReadonlyMap<string, Hunk>): string[] {
  const byId = new Map([...labels.values()].map((hunk) => [hunk.id, hunk.path]));
  return [...new Set(hunkIds.map((id) => byId.get(id)).filter((path): path is string => path !== undefined))];
}

const DIAGRAM_TYPES =
  /^(sequenceDiagram|flowchart|graph|stateDiagram(-v2)?|erDiagram|classDiagram|journey|gantt|mindmap|timeline)\b/;

/**
 * Accept a diagram only if it is one.
 *
 * A model that answers this field with prose would put that prose where a picture goes, and
 * the preview would render a broken code block instead of saying nothing — which is worse
 * than the omission the field is supposed to default to.
 */
function diagramOf(value: unknown): string {
  const source = text(value)
    .replace(/^```(?:mermaid)?\s*\n?/i, '')
    .replace(/\n?```$/, '')
    .trim();
  return DIAGRAM_TYPES.test(source) ? source : '';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function oneOf<T extends string, F extends string>(value: unknown, allowed: readonly T[], fallback: F): T | F {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
