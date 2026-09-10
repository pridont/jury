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
 * Parse and shape-check model output.
 *
 * Raw model text never reaches a structured code path: either it parses and matches the
 * contract, or the caller gets an error string precise enough to quote back in a repair
 * request.
 */
export function parse<T>(text: string, shape: Shape): ParseResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(stripFence(text));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not be parsed as JSON' };
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

/** What to send back when the first answer did not parse. */
export function repairPrompt(error: string): string {
  return [
    'That reply could not be used:',
    error,
    '',
    'Send the JSON object again, on its own, with no prose and no code fence.',
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
