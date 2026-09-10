import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Beyond this the oldest entries are dropped; a cache is not a place to keep everything. */
const MAX_ENTRIES = 500;

export type CacheKey = { promptVersion: number; model: string; input: string };

/**
 * Answers on disk, keyed by exactly what produced them.
 *
 * Reopening a review costs nothing and starts no subprocess, and editing a prompt
 * invalidates precisely the answers that prompt produced — the version is part of the key,
 * so a changed prompt cannot serve stale text from the old one.
 */
export class Cache {
  constructor(private readonly dir: string) {}

  static key({ promptVersion, model, input }: CacheKey): string {
    return createHash('sha1').update(`${promptVersion}\0${model}\0${input}`).digest('hex');
  }

  async get(key: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.dir, `${key}.txt`), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Only ever called once a caller has accepted the answer.
   *
   * Schema-valid is not the same as usable: a clustering that organised nothing parses
   * perfectly, and caching it would mean replaying a known-bad result on every open until
   * somebody refreshed by hand.
   */
  async set(key: string, value: string): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const file = path.join(this.dir, `${key}.txt`);
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, value);
      await fs.rename(temporary, file);
      await this.prune();
    } catch {
      // A cache that cannot be written is a slower review, not a broken one.
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true });
  }

  async size(): Promise<number> {
    try {
      return (await fs.readdir(this.dir)).filter((name) => name.endsWith('.txt')).length;
    } catch {
      return 0;
    }
  }

  private async prune(): Promise<void> {
    const names = (await fs.readdir(this.dir)).filter((name) => name.endsWith('.txt'));
    if (names.length <= MAX_ENTRIES) return;

    const stats = await Promise.all(
      names.map(async (name) => {
        const file = path.join(this.dir, name);
        const stat = await fs.stat(file).catch(() => null);
        return { file, at: stat?.mtimeMs ?? 0 };
      }),
    );
    stats.sort((a, b) => a.at - b.at);

    await Promise.all(stats.slice(0, stats.length - MAX_ENTRIES).map(({ file }) => fs.rm(file, { force: true })));
  }
}
