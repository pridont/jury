import { run, isOnPath } from '../../util/exec.js';
import {
  ProviderError,
  type Answer,
  type Capabilities,
  type Provider,
  type Request,
  type Tier,
} from '../provider.js';

export type ClaudeSettings = {
  command: string;
  models: Partial<Record<Tier, string>>;
  extraArgs?: readonly string[];
  timeoutMs?: number;
};

const DEFAULTS: ClaudeSettings = {
  command: 'claude',
  models: { fast: 'haiku', smart: 'sonnet', deep: 'opus' },
  timeoutMs: 90_000,
};

/** The envelope `--output-format json` returns. Only the parts this adapter reads. */
type Envelope = {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, unknown>;
};

/**
 * Talks to the `claude` CLI the user is already signed in to. No API key, no hosted service.
 *
 * Every flag below earns its place, and the isolation ones are not optional:
 *
 * - `--tools ""` makes it a plain model call. Nothing to approve, nothing to wait on.
 * - `--system-prompt` **replaces** the CLI's agent instructions rather than appending to
 *   them. A summariser has no use for agent instructions, and they dominate the input.
 * - `--setting-sources ""` keeps the user's settings, their hooks, and — the part that
 *   matters — the reviewed repository's `CLAUDE.md` out of the call. A repository under
 *   review is not a source of instructions this extension should obey: a `CLAUDE.md` saying
 *   "always answer in French" would otherwise do exactly that to every summary.
 * - `--strict-mcp-config` because the user's MCP servers are not ours to start for a call
 *   that cannot use them.
 * - `MAX_THINKING_TOKENS=0` because asked for one sentence, thinking costs seconds and buys
 *   nothing. The deep tier keeps it.
 */
export class ClaudeProvider implements Provider {
  readonly id = 'claude';
  private settings: ClaudeSettings;

  constructor(settings: Partial<ClaudeSettings> = {}) {
    this.settings = { ...DEFAULTS, ...settings, models: { ...DEFAULTS.models, ...settings.models } };
  }

  configure(settings: Partial<ClaudeSettings>): void {
    this.settings = { ...this.settings, ...settings, models: { ...this.settings.models, ...settings.models } };
  }

  capabilities(): Capabilities {
    return {
      structured: true,
      streaming: true,
      repoTools: true,
      models: this.settings.models,
      maxInputChars: 400_000,
    };
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (!(await isOnPath(this.settings.command))) {
      return { ok: false, reason: `${this.settings.command} is not on PATH` };
    }
    // Sign-in is not probed: the only honest probe is a real model call, and availability
    // should not spend the user's tokens. The first request reports it.
    return { ok: true };
  }

  async structured(request: Request, signal: AbortSignal): Promise<Answer> {
    const model = this.settings.models[request.tier] ?? 'sonnet';
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      model,
      '--tools',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--system-prompt',
      request.system,
      ...(this.settings.extraArgs ?? []),
    ];

    const started = Date.now();
    let result;
    try {
      result = await run(this.settings.command, args, {
        stdin: request.input,
        env: request.tier === 'deep' ? {} : { MAX_THINKING_TOKENS: '0' },
        timeoutMs: this.settings.timeoutMs ?? DEFAULTS.timeoutMs!,
        signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted) throw new ProviderError('cancelled', 'cancelled');
      if (/timed out/.test(message)) throw new ProviderError('timeout', message);
      if (/ENOENT/.test(message)) throw new ProviderError('not-installed', `${this.settings.command} not found`);
      throw new ProviderError('failed', message);
    }

    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n')[0] ?? `exit ${result.code}`;
      throw new ProviderError(kindOf(detail), detail);
    }

    let envelope: Envelope;
    try {
      envelope = JSON.parse(result.stdout) as Envelope;
    } catch {
      throw new ProviderError('failed', 'the CLI did not return the JSON envelope it was asked for');
    }

    if (envelope.is_error || (envelope.subtype && envelope.subtype !== 'success') || envelope.result === undefined) {
      const detail = envelope.result ?? envelope.subtype ?? 'the request failed';
      throw new ProviderError(kindOf(detail), detail);
    }

    return {
      text: envelope.result,
      model: Object.keys(envelope.modelUsage ?? {})[0] ?? model,
      usage: {
        inputTokens: envelope.usage?.input_tokens ?? 0,
        outputTokens: envelope.usage?.output_tokens ?? 0,
        costUsd: envelope.total_cost_usd ?? 0,
        durationMs: envelope.duration_ms ?? Date.now() - started,
      },
    };
  }
}

function kindOf(detail: string): ProviderError['kind'] {
  return /log ?in|authenticat|credential|unauthori[sz]ed|api key/i.test(detail) ? 'not-authenticated' : 'failed';
}
