import { describe, expect, it } from 'vitest';
import { merge } from '../../src/model/merge.js';
import type { Hunk } from '../../src/model/types.js';

const labels = (paths: string[]) =>
  new Map(
    paths.map((path, index) => [
      `h${index + 1}`,
      {
        id: `id${index + 1}`,
        path,
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: ['+x'],
        stats: { added: 1, removed: 0 },
        kind: 'text',
      } satisfies Hunk,
    ]),
  );

const two = labels(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
const cohorts = [
  { id: 'c1', title: 'A', summary: 's', kind: 'feature', risk: 'low', layers: [{ id: 'l', title: 'l', summary: '', hunks: ['h1', 'h2'] }] },
  { id: 'c2', title: 'B', summary: 's', kind: 'test', risk: 'low', layers: [{ id: 'l', title: 'l', summary: '', hunks: ['h3', 'h4'] }] },
];

const diagramOf = (diagram: unknown) => {
  const result = merge({ cohorts, diagram }, two);
  if (!result.ok) throw new Error(result.reason);
  return result.merged.diagram;
};

describe('the diagram field', () => {
  it('accepts a real mermaid diagram', () => {
    expect(diagramOf('sequenceDiagram\n  A->>B: hello')).toBe('sequenceDiagram\n  A->>B: hello');
  });

  it('accepts every diagram type the walkthrough can draw', () => {
    for (const type of ['flowchart TD', 'graph LR', 'stateDiagram-v2', 'erDiagram', 'classDiagram']) {
      expect(diagramOf(`${type}\n  A --> B`), type).not.toBe('');
    }
  });

  it('unwraps a fence the model added anyway', () => {
    expect(diagramOf('```mermaid\nflowchart TD\n  A --> B\n```')).toBe('flowchart TD\n  A --> B');
  });

  it('refuses prose, which would render as a broken block instead of nothing', () => {
    expect(diagramOf('This change adds a clock port and threads it through.')).toBe('');
  });

  it('is empty when the model left it out, which is the normal answer', () => {
    expect(diagramOf(undefined)).toBe('');
    expect(diagramOf('')).toBe('');
  });

  it('refuses a diagram type it does not know rather than guessing', () => {
    expect(diagramOf('pieChart\n  a: 1')).toBe('');
  });
});
