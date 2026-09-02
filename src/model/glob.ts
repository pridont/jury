/**
 * A small glob matcher for scaffolding patterns.
 *
 * Deliberately not a dependency: the patterns here are path shapes — `dist/`, `*.lock`,
 * `**\/__snapshots__/**` — and a matcher for those is twenty lines. Semantics follow
 * gitignore closely enough to be unsurprising:
 *
 * - `*` matches within one segment, `**` across segments.
 * - A pattern containing no `/` matches the basename anywhere.
 * - A trailing `/` matches a directory and everything under it.
 * - A leading `/` anchors to the repository root.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = pattern;
  const anchored = source.startsWith('/');
  if (anchored) source = source.slice(1);

  const directory = source.endsWith('/');
  if (directory) source = source.slice(0, -1);

  const basenameOnly = !anchored && !source.includes('/');

  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === '*') {
      if (source[i + 1] === '*') {
        // `**/` may match nothing at all, so the separator is part of the optional group.
        if (source[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  const head = basenameOnly ? '(?:.*/)?' : '';
  const tail = directory ? '(?:/.*)?' : '';
  return new RegExp(`^${head}${out}${tail}$`);
}

export class GlobSet {
  private readonly matchers: RegExp[];

  constructor(patterns: readonly string[]) {
    this.matchers = patterns.map(globToRegExp);
  }

  matches(path: string): boolean {
    return this.matchers.some((re) => re.test(path));
  }
}
