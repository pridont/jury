import { describe, expect, it } from 'vitest';
import { disambiguate, hunkBody, hunkId } from '../../src/git/identity.js';

describe('hunkBody', () => {
  it('keeps only the changed lines, with their sign', () => {
    expect(hunkBody([' context', '-old', '+new', ' context'])).toBe('-old\n+new');
  });

  it('ignores trailing whitespace, which no reviewer is judging', () => {
    expect(hunkBody(['-old   ', '+new\t'])).toBe(hunkBody(['-old', '+new']));
  });

  it('distinguishes an addition from a deletion of the same text', () => {
    expect(hunkBody(['+x'])).not.toBe(hunkBody(['-x']));
  });

  it('drops the "\\ No newline" marker, which is not a changed line', () => {
    expect(hunkBody(['-a', '\\ No newline at end of file', '+a'])).toBe('-a\n+a');
  });
});

describe('hunkId', () => {
  it('is stable for the same path and body', () => {
    expect(hunkId('a.ts', '-x\n+y')).toBe(hunkId('a.ts', '-x\n+y'));
  });

  it('changes when the body changes, so a mark cannot survive an edit', () => {
    expect(hunkId('a.ts', '-x\n+y')).not.toBe(hunkId('a.ts', '-x\n+z'));
  });

  it('changes with the path, so identical edits in two files stay distinct', () => {
    expect(hunkId('a.ts', '-x\n+y')).not.toBe(hunkId('b.ts', '-x\n+y'));
  });

  it('is short enough to read and long enough not to collide', () => {
    expect(hunkId('a.ts', '-x')).toHaveLength(16);
  });
});

describe('disambiguate', () => {
  it('leaves distinct ids alone', () => {
    expect(disambiguate(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('numbers repeats from the second occurrence', () => {
    expect(disambiguate(['a', 'a', 'b', 'a'])).toEqual(['a', 'a:2', 'b', 'a:3']);
  });
});
