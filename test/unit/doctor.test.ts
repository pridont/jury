import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { doctor, formatChecks } from '../../src/doctor.js';

describe('doctor', () => {
  it('reports git as required and found', async () => {
    const checks = await doctor(process.cwd());
    const git = checks.find((c) => c.name === 'git');
    expect(git).toMatchObject({ ok: true, required: true });
  });

  it('says plainly when the cwd is not a repository', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'changestack-doctor-'));
    try {
      const checks = await doctor(outside);
      const repo = checks.find((c) => c.name === 'repository');
      expect(repo?.ok).toBe(false);
      expect(repo?.detail).toContain('not inside a git repository');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('treats a missing provider as optional, not as a failure to open a review', async () => {
    const checks = await doctor(process.cwd());
    for (const name of ['gh', 'claude']) {
      expect(checks.find((c) => c.name === name)?.required).toBe(false);
    }
  });

  it('formats one line per check', async () => {
    const text = formatChecks(await doctor(process.cwd()));
    expect(text.split('\n')).toHaveLength(4);
  });
});
