export type Shape = Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object'>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Models wrap JSON in a code fence even when told not to — measured, not assumed — so this
 * strips one before parsing rather than treating it as a failure worth a retry.
 */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json|jsonc)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1].trim();

  // Some answers put prose around the object. Take the outermost braces rather than giving
  // up on an answer that is present but not alone.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) return trimmed.slice(first, last + 1);

  return trimmed;
}

/**
 * Fix the malformations a model actually produces, before spending a call on asking it to.
 *
 * Two are common enough to be worth handling mechanically: a raw newline inside a string —
 * which is how a multi-line summary or a mermaid diagram usually arrives — and a trailing
 * comma before a closing brace. Both are unambiguous to repair. Anything subtler is left
 * alone rather than guessed at.
 */
export function salvage(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString && (char === '\n' || char === '\r' || char === '\t')) {
      out += char === '\t' ? '\\t' : char === '\r' ? '' : '\\n';
      continue;
    }
    out += char;
  }

  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Parse and shape-check model output.
 *
 * Raw model text never reaches a structured code path: either it parses and matches the
 * contract, or the caller gets an error string precise enough to quote back in a repair
 * request.
 */
export function parse<T>(text: string, shape: Shape): ParseResult<T> {
  const stripped = stripFence(text);
  let value: unknown;
  try {
    value = JSON.parse(stripped);
  } catch (first) {
    try {
      value = JSON.parse(salvage(stripped));
    } catch {
      return { ok: false, error: first instanceof Error ? first.message : 'could not be parsed as JSON' };
    }
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'expected a JSON object at the top level' };
  }

  const record = value as Record<string, unknown>;
  for (const [field, kind] of Object.entries(shape)) {
    const actual = record[field];
    if (actual === undefined) return { ok: false, error: `missing field "${field}"` };
    if (!matches(actual, kind)) {
      return { ok: false, error: `field "${field}" should be ${kind}, got ${describe(actual)}` };
    }
  }

  return { ok: true, value: record as T };
}

/**
 * Ask for the broken answer back, fixed.
 *
 * The answer itself has to be in the request or this is not a repair, it is the same
 * question asked again at the same price — with an error message attached that the model
 * has no way to connect to anything it said.
 */
export function repairPrompt(error: string, broken: string): string {
  return [
    'The JSON below could not be parsed:',
    '',
    error,
    '',
    'Here is exactly what was sent:',
    '',
    broken.slice(0, 60_000),
    '',
    'Return the same object with that fixed, and nothing else. Keep every field and every',
    'value as they are — only the JSON itself is wrong. No prose, no code fence. Newlines',
    'inside a string must be written \\n.',
  ].join('\n');
}

function matches(value: unknown, kind: Shape[string]): boolean {
  switch (kind) {
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return typeof value === kind;
  }
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}
