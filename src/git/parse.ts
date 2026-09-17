import type { Hunk, HunkKind } from '../model/types.js';
import { disambiguate, hunkBody, hunkId } from './identity.js';

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

export type FileChange = {
  /** The path after the change; for a deletion, the path that was removed. */
  path: string;
  /** Set for renames and copies. */
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  /** Rename/copy similarity, 0-100, when git reported one. */
  similarity?: number;
  hunks: Hunk[];
  stats: { added: number; removed: number };
};

/**
 * Which side of a diff holds a file's content.
 *
 * Only a deletion answers `old`: the file exists in the base and nowhere else. The reading
 * UI needs this to know which pane a hunk can be revealed in, and which of a hunk's two
 * line numbers is the real one there.
 */
export function contentSide(file: Pick<FileChange, 'status'>): 'old' | 'new' {
  return file.status === 'deleted' ? 'old' : 'new';
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse a unified diff produced by `git diff`.
 *
 * Everything downstream trusts this layer, so it is total: any file git can report has to
 * come back with at least one hunk. A change with no textual hunks — a binary file, a pure
 * rename, a mode change, an added empty file — is given one synthetic hunk, because a change
 * that cannot be listed cannot be reviewed or marked.
 */
export function parseDiff(text: string): FileChange[] {
  const lines = splitLines(text);
  const files: FileChange[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (!line.startsWith('diff --git ')) {
      i += 1;
      continue;
    }
    const [file, next] = parseFile(lines, i);
    files.push(file);
    i = next;
  }

  return files;
}

function parseFile(lines: string[], start: number): [FileChange, number] {
  const header = lines[start] ?? '';
  const headerPaths = parseGitHeaderPaths(header.slice('diff --git '.length));

  let path = headerPaths?.[1] ?? headerPaths?.[0] ?? '';
  let oldPath: string | undefined;
  let status: FileStatus = 'modified';
  let binary = false;
  let oldMode: string | undefined;
  let newMode: string | undefined;
  let similarity: number | undefined;
  const hunks: Hunk[] = [];

  let i = start + 1;

  // Extended headers, then the ---/+++ pair, then hunks. Any of these may be absent.
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.startsWith('diff --git ')) break;

    if (line.startsWith('@@')) break;

    if (line.startsWith('new file mode ')) {
      status = 'added';
      newMode = line.slice('new file mode '.length).trim();
    } else if (line.startsWith('deleted file mode ')) {
      status = 'deleted';
      oldMode = line.slice('deleted file mode '.length).trim();
    } else if (line.startsWith('old mode ')) {
      oldMode = line.slice('old mode '.length).trim();
    } else if (line.startsWith('new mode ')) {
      newMode = line.slice('new mode '.length).trim();
    } else if (line.startsWith('similarity index ')) {
      similarity = Number.parseInt(line.slice('similarity index '.length), 10);
    } else if (line.startsWith('rename from ')) {
      status = 'renamed';
      oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      status = 'renamed';
      path = line.slice('rename to '.length);
    } else if (line.startsWith('copy from ')) {
      status = 'copied';
      oldPath = line.slice('copy from '.length);
    } else if (line.startsWith('copy to ')) {
      status = 'copied';
      path = line.slice('copy to '.length);
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true;
    } else if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4));
      if (p === null) status = 'added';
      else if (!oldPath) oldPath = p;
    } else if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4));
      if (p === null) status = 'deleted';
      else path = p;
    }
  }

  // Hunks.
  for (; i < lines.length; ) {
    const line = lines[i];
    if (line === undefined || line.startsWith('diff --git ')) break;
    const match = HUNK_HEADER.exec(line);
    if (!match) {
      i += 1;
      continue;
    }
    const [hunk, next] = parseHunk(lines, i, match, path);
    hunks.push(hunk);
    i = next;
  }

  if (status === 'deleted' && oldPath && path === '') path = oldPath;
  if (status === 'renamed' || status === 'copied') {
    // A rename with content changes also carries ---/+++ lines; the rename headers win.
  } else if (oldPath === path) {
    oldPath = undefined;
  }

  const stats = hunks.reduce(
    (acc, h) => ({ added: acc.added + h.stats.added, removed: acc.removed + h.stats.removed }),
    { added: 0, removed: 0 },
  );

  const file: FileChange = { path, status, binary, hunks, stats };
  if (oldPath !== undefined && oldPath !== path) file.oldPath = oldPath;
  if (oldMode !== undefined) file.oldMode = oldMode;
  if (newMode !== undefined) file.newMode = newMode;
  if (similarity !== undefined) file.similarity = similarity;

  if (hunks.length === 0) {
    file.hunks.push(syntheticHunk(file));
  }

  assignIds(file);
  return [file, i];
}

function parseHunk(lines: string[], start: number, match: RegExpExecArray, path: string): [Hunk, number] {
  const oldStart = Number.parseInt(match[1] ?? '0', 10);
  const oldCount = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
  const newStart = Number.parseInt(match[3] ?? '0', 10);
  const newCount = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);
  const section = (match[5] ?? '').trim();

  const body: string[] = [];
  let added = 0;
  let removed = 0;
  let oldSeen = 0;
  let newSeen = 0;

  let i = start + 1;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    const first = line[0];

    if (line.startsWith('diff --git ') || line.startsWith('@@')) break;

    if (first === '+') {
      added += 1;
      newSeen += 1;
    } else if (first === '-') {
      removed += 1;
      oldSeen += 1;
    } else if (first === ' ' || line === '') {
      oldSeen += 1;
      newSeen += 1;
    } else if (first === '\\') {
      // "\ No newline at end of file" — metadata about the line before it.
      body.push(line);
      continue;
    } else {
      break;
    }

    body.push(line);
    if (oldSeen >= oldCount && newSeen >= newCount) {
      i += 1;
      // The "\\ No newline at end of file" marker trails the last line and is not counted
      // by the @@ header, so it has to be claimed explicitly or it is lost with the hunk.
      const trailer = lines[i];
      if (trailer?.startsWith('\\')) {
        body.push(trailer);
        i += 1;
      }
      break;
    }
  }

  const hunk: Hunk = {
    id: '',
    path,
    oldStart,
    oldCount,
    newStart,
    newCount,
    lines: body,
    stats: { added, removed },
    kind: 'text',
  };
  if (section) hunk.symbol = section;
  return [hunk, i];
}

/**
 * A change with no textual hunks still has to be listed and markable, so it gets one hunk
 * whose body describes the change itself.
 */
function syntheticHunk(file: FileChange): Hunk {
  let kind: HunkKind = 'empty';
  let description = '<empty>';

  if (file.binary) {
    kind = 'binary';
    description = '<binary>';
  } else if (file.status === 'renamed' || file.status === 'copied') {
    kind = 'rename';
    description = `<${file.status}: ${file.oldPath ?? '?'} -> ${file.path}>`;
  } else if (file.oldMode && file.newMode && file.oldMode !== file.newMode) {
    kind = 'mode';
    description = `<mode: ${file.oldMode} -> ${file.newMode}>`;
  }

  return {
    id: '',
    path: file.path,
    oldStart: 0,
    oldCount: 0,
    newStart: 0,
    newCount: 0,
    lines: [description],
    stats: { added: 0, removed: 0 },
    kind,
  };
}

function assignIds(file: FileChange): void {
  const raw = file.hunks.map((hunk) =>
    hunkId(file.path, hunk.kind === 'text' ? hunkBody(hunk.lines) : (hunk.lines[0] ?? '')),
  );
  const ids = disambiguate(raw);
  file.hunks.forEach((hunk, index) => {
    hunk.id = ids[index] ?? raw[index] ?? '';
  });
}

/** `a/path` -> `path`; `/dev/null` -> null, which is how git says "this side is absent". */
function stripPrefix(value: string): string | null {
  const path = value.replace(/\t.*$/, '');
  if (path === '/dev/null') return null;
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

/**
 * `a/x b/x` -> ['x', 'x'].
 *
 * Paths may contain spaces, which makes the header ambiguous in general. Prefer the split
 * where both halves agree, which is every case except a rename — and a rename carries its
 * own `rename from`/`rename to` headers that override whatever this returns.
 */
export function parseGitHeaderPaths(value: string): [string, string] | null {
  let fallback: [string, string] | null = null;
  for (let at = value.indexOf(' b/'); at !== -1; at = value.indexOf(' b/', at + 1)) {
    const left = value.slice(0, at);
    const right = value.slice(at + 1);
    if (!left.startsWith('a/')) continue;
    const a = left.slice(2);
    const b = right.slice(2);
    if (a === b) return [a, b];
    fallback ??= [a, b];
  }
  return fallback;
}

/** Split on newlines, keeping any `\r` so CRLF content survives round-tripping. */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
