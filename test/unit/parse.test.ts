import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseDiff, parseGitHeaderPaths } from '../../src/git/parse.js';

// vitest runs from the project root; keeping this a plain relative path avoids import.meta,
// which tsc rejects under the CommonJS output the extension host loads.
const dir = path.resolve('test/fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(dir, `${name}.diff`), 'utf8');

describe('parseDiff', () => {
  it('parses a modification into hunks with exact line ranges and stats', () => {
    const [file, ...rest] = parseDiff(fixture('modify'));
    expect(rest).toHaveLength(0);
    expect(file).toMatchObject({ path: 'modify.txt', status: 'modified', binary: false });
    expect(file!.hunks).toHaveLength(1);
    expect(file!.hunks[0]).toMatchObject({
      path: 'modify.txt',
      oldStart: 1,
      oldCount: 8,
      newStart: 1,
      newCount: 8,
      kind: 'text',
      stats: { added: 2, removed: 2 },
    });
    expect(file!.stats).toEqual({ added: 2, removed: 2 });
  });

  it('separates an addition from a deletion', () => {
    const files = parseDiff(fixture('add-delete'));
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['added.txt']).toMatchObject({ status: 'added' });
    expect(byPath['modify.txt']).toMatchObject({ status: 'deleted' });
    expect(byPath['added.txt']!.hunks[0]!.stats).toEqual({ added: 2, removed: 0 });
  });

  it('gives a pure rename one synthetic hunk, so it can be listed and marked', () => {
    const [file] = parseDiff(fixture('rename-pure'));
    expect(file).toMatchObject({
      path: 'renamed.txt',
      oldPath: 'added.txt',
      status: 'renamed',
      similarity: 100,
    });
    expect(file!.hunks).toHaveLength(1);
    expect(file!.hunks[0]!.kind).toBe('rename');
  });

  it('keeps both the rename and the edits when a file moved and changed', () => {
    const [file] = parseDiff(fixture('rename-edit'));
    expect(file).toMatchObject({ path: 'moved.txt', oldPath: 'renamed.txt', status: 'renamed' });
    expect(file!.hunks).toHaveLength(1);
    expect(file!.hunks[0]!.kind).toBe('text');
    expect(file!.stats).toEqual({ added: 1, removed: 1 });
  });

  it('gives a mode change a synthetic hunk naming both modes', () => {
    const [file] = parseDiff(fixture('mode'));
    expect(file).toMatchObject({ oldMode: '100644', newMode: '100755' });
    expect(file!.hunks[0]!.kind).toBe('mode');
    expect(file!.hunks[0]!.lines[0]).toBe('<mode: 100644 -> 100755>');
  });

  it('marks a binary file and still yields one hunk', () => {
    const [file] = parseDiff(fixture('binary'));
    expect(file).toMatchObject({ path: 'blob.bin', binary: true, status: 'added' });
    expect(file!.hunks).toHaveLength(1);
    expect(file!.hunks[0]!.kind).toBe('binary');
  });

  it('gives an added empty file a hunk rather than dropping it', () => {
    const [file] = parseDiff(fixture('empty-file'));
    expect(file).toMatchObject({ path: 'empty.txt', status: 'added' });
    expect(file!.hunks).toHaveLength(1);
    expect(file!.hunks[0]!.kind).toBe('empty');
  });

  it('carries the "\\ No newline" marker without counting it as a change', () => {
    const [file] = parseDiff(fixture('nonewline-fixed'));
    const hunk = file!.hunks[0]!;
    expect(hunk.lines).toContain('\\ No newline at end of file');
    expect(hunk.stats).toEqual({ added: 1, removed: 1 });
  });

  it('preserves CR so CRLF content round-trips', () => {
    const [file] = parseDiff(fixture('crlf'));
    const added = file!.hunks[0]!.lines.filter((l) => l.startsWith('+'));
    expect(added).toEqual(['+TWO\r']);
  });

  it('reads a path containing spaces, tab suffix and all', () => {
    const [file] = parseDiff(fixture('paths-spaces'));
    expect(file!.path).toBe('a file with spaces.txt');
    expect(file!.hunks[0]!.path).toBe('a file with spaces.txt');
  });

  it('keeps two identical hunks independently reviewable', () => {
    const [file] = parseDiff(fixture('duplicate-hunks'));
    const [first, second] = file!.hunks;
    expect(file!.hunks).toHaveLength(2);
    expect(second!.id).toBe(`${first!.id}:2`);
    expect(first!.newStart).toBe(1);
    expect(second!.newStart).toBe(8);
  });

  it('splits a multi-file diff without leaking hunks across files', () => {
    const files = parseDiff(fixture('multi'));
    expect(files.map((f) => f.path).sort()).toEqual(['four.txt', 'one.txt', 'three.txt', 'two.txt']);
    for (const file of files) {
      for (const hunk of file.hunks) expect(hunk.path).toBe(file.path);
    }
    expect(files.find((f) => f.path === 'three.txt')!.status).toBe('deleted');
  });

  it('records the section heading git puts after @@ as the enclosing symbol', () => {
    const [file] = parseDiff(fixture('duplicate-hunks'));
    expect(file!.hunks[1]!.symbol).toBe('keep');
  });

  it('returns nothing for an empty diff', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('parses 10k lines well inside budget', () => {
    const out: string[] = ['diff --git a/big.txt b/big.txt', 'index 111..222 100644', '--- a/big.txt', '+++ b/big.txt'];
    for (let i = 0; i < 1500; i += 1) {
      out.push(`@@ -${i * 10 + 1},5 +${i * 10 + 1},5 @@ section${i}`);
      out.push(' context', `-old ${i}`, `+new ${i}`, ' context', ' context', ' context');
    }
    const text = out.join('\n') + '\n';
    expect(text.split('\n').length).toBeGreaterThan(10_000);

    const start = performance.now();
    const files = parseDiff(text);
    const elapsed = performance.now() - start;

    expect(files[0]!.hunks).toHaveLength(1500);
    expect(elapsed).toBeLessThan(150);
  });
});

describe('parseGitHeaderPaths', () => {
  it('prefers the split where both halves agree', () => {
    expect(parseGitHeaderPaths('a/a b/c.txt b/a b/c.txt')).toEqual(['a b/c.txt', 'a b/c.txt']);
  });

  it('falls back to the first plausible split for a rename', () => {
    expect(parseGitHeaderPaths('a/old.txt b/new.txt')).toEqual(['old.txt', 'new.txt']);
  });

  it('is null when the header is not a pair', () => {
    expect(parseGitHeaderPaths('nonsense')).toBeNull();
  });
});
