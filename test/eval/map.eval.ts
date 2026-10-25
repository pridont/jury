import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { Cache } from '../../src/agent/cache.js';
import { Queue } from '../../src/agent/queue.js';
import { clusterChange } from '../../src/agent/cluster.js';
import { ClaudeProvider } from '../../src/agent/providers/claude.js';
import { load } from './harness.js';

/**
 * Does the model place a change in the codebase when given a map of it?
 *
 * `auth-clock` read against a map whose areas have names the diff never uses. A summary that
 * names one of them came from the map; without the map, none should.
 */
const MAP = [
  'Tour of shop: An online shop API. Requests come in through the Gateway, which checks the caller with the Identity service before handing over to Orders.',
  '',
  'Areas, and the files read for each:',
  '- Gateway: http/server.ts, http/middleware.ts',
  '- Identity service: auth/token.ts, auth/session.ts',
  '- Orders: orders/cart.ts, orders/checkout.ts',
  '',
  'How they fit together:',
  'flowchart TD\n  gw["Gateway"] --> id["Identity service"]\n  gw --> orders["Orders"]',
].join('\n');

const NAMED = /gateway|identity service/i;

const cache = new Cache(path.resolve('test/eval/.cache'));

describe('codebase map', () => {
  for (const [name, map] of [['with the map', MAP], ['without', '']] as const) {
    it(name, async () => {
      const provider = new ClaudeProvider();
      expect((await provider.available()).ok, 'claude must be available to run the eval').toBe(true);

      const result = await clusterChange(
        { provider, queue: new Queue(2), cache, owner: 'eval', log: () => {} },
        load('auth-clock').files,
        new Map(),
        false,
        '',
        map,
      );
      expect(result.ok, result.ok ? '' : `declined: ${result.reason}`).toBe(true);
      if (!result.ok) return;

      const { cohorts, notes } = result.merged;
      const text = cohorts.map((c) => `${c.title}: ${c.summary}`);
      console.log(`\n=== ${name} ===\n${text.map((t) => `  - ${t}`).join('\n')}\n  notes: ${notes.join(' | ') || '(none)'}`);

      expect(text.some((t) => NAMED.test(t)), 'a cohort named in the map\'s terms').toBe(map !== '');
      // The map is background: no note about it.
      expect(notes.some((n) => /map|tour/i.test(n))).toBe(false);
    });
  }
});
