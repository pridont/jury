import { run, runStreaming, isOnPath } from '../../util/exec.js';
import {
  ProviderError,
  type Answer,
  type Capabilities,
  type Chunk,
  type Provider,
  type Request,
  type Tier,
  type ToolCapability,
  type Usage,
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

  /**
   * The streaming tier, where reading the surrounding repository is the point.
   *
   * The tool set is read-only by design — a review tool must never edit the code it is
   * reviewing — and `--add-dir` scopes it to the repository under review. Thinking is left
   * on here, unlike the structured tier: the questions asked of this one are the hard ones.
   *
   * A follow-up resumes rather than restates. The first question carries the diff and the
   * session id comes back with the answer; every question after it sends only the question,
   * so the diff stays in the provider's own cache instead of being paid for again.
   */
  async stream(request: Request, signal: AbortSignal, onChunk: (chunk: Chunk) => void): Promise<Answer> {
    const model = this.settings.models[request.tier] ?? 'sonnet';
    const tools = (request.tools ?? []).map((tool) => TOOLS[tool]).filter(Boolean);

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      // Not optional: the CLI refuses stream-json without it.
      '--verbose',
      '--model',
      model,
      '--setting-sources',
      '',
      '--strict-mcp-config',
    ];

    if (tools.length > 0) {
      args.push('--tools', tools.join(','), '--permission-mode', 'dontAsk');
      if (request.cwd) args.push('--add-dir', request.cwd);
    } else {
      args.push('--tools', '');
    }

    if (request.session?.resume) args.push('--resume', request.session.id);
    else args.push('--system-prompt', request.system);

    args.push(...(this.settings.extraArgs ?? []));

    let text = '';
    let session = request.session?.id ?? '';
    let usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
    let failure = '';

    // Tool input arrives as JSON fragments; hold them until the block closes so the label
    // can name what the tool was actually asked for.
    const openTools = new Map<number, { name: string; json: string }>();

    const started = Date.now();
    const result = await runStreaming(this.settings.command, args, {
      stdin: request.input,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      timeoutMs: this.settings.timeoutMs ?? DEFAULTS.timeoutMs!,
      signal,
      onLine: (line) => {
        let parsed: StreamLine;
        try {
          parsed = JSON.parse(line) as StreamLine;
        } catch {
          return;
        }

        if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
          session = parsed.session_id;
          return;
        }

        if (parsed.type === 'result') {
          if (parsed.is_error || (parsed.subtype && parsed.subtype !== 'success')) {
            failure = parsed.result ?? parsed.subtype ?? 'the request failed';
          }
          if (parsed.session_id) session = parsed.session_id;
          usage = {
            inputTokens: parsed.usage?.input_tokens ?? 0,
            outputTokens: parsed.usage?.output_tokens ?? 0,
            costUsd: parsed.total_cost_usd ?? 0,
            durationMs: parsed.duration_ms ?? Date.now() - started,
          };
          return;
        }

        const event = parsed.event;
        if (parsed.type !== 'stream_event' || !event) return;

        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          openTools.set(event.index ?? 0, { name: event.content_block.name ?? 'tool', json: '' });
          return;
        }

        if (event.type === 'content_block_delta') {
          // Thinking is not the answer, and streaming it would bury the answer in it.
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            text += event.delta.text;
            onChunk({ kind: 'text', text: event.delta.text });
          } else if (event.delta?.type === 'input_json_delta') {
            const open = openTools.get(event.index ?? 0);
            if (open) open.json += event.delta.partial_json ?? '';
          }
          return;
        }

        if (event.type === 'content_block_stop') {
          const open = openTools.get(event.index ?? 0);
          if (open) {
            openTools.delete(event.index ?? 0);
            onChunk({ kind: 'tool', label: toolLabel(open.name, open.json) });
          }
        }
      },
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted) throw new ProviderError('cancelled', 'cancelled');
      if (/timed out/.test(message)) throw new ProviderError('timeout', message);
      if (/ENOENT/.test(message)) throw new ProviderError('not-installed', `${this.settings.command} not found`);
      throw new ProviderError('failed', message);
    });

    if (failure) throw new ProviderError(kindOf(failure), failure);
    if (result.code !== 0) {
      const detail = result.stderr.trim().split('\n')[0] ?? `exit ${result.code}`;
      throw new ProviderError(kindOf(detail), detail);
    }

    const answer: Answer = { text, model, usage };
    if (session) answer.session = session;
    return answer;
  }
}

/** `Grep {"pattern":"isExpired"}` reads as noise; `Grep isExpired` reads as a reason. */
function toolLabel(name: string, json: string): string {
  try {
    const input = JSON.parse(json) as Record<string, unknown>;
    const first = ['pattern', 'query', 'file_path', 'path', 'command'].find(
      (key) => typeof input[key] === 'string',
    );
    return first ? `${name} ${String(input[first])}` : name;
  } catch {
    return name;
  }
}

/** This CLI's names for the capabilities a request asks for. */
const TOOLS: Record<ToolCapability, string> = {
  readFile: 'Read',
  search: 'Grep',
  listFiles: 'Glob',
};

/** One line of `--output-format stream-json`, in the shapes this adapter reads. */
type StreamLine = {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  event?: {
    type?: string;
    index?: number;
    content_block?: { type?: string; name?: string };
    delta?: { type?: string; text?: string; partial_json?: string };
  };
};

function kindOf(detail: string): ProviderError['kind'] {
  return /log ?in|authenticat|credential|unauthori[sz]ed|api key/i.test(detail) ? 'not-authenticated' : 'failed';
}
