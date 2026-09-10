/** What a provider can do. Drives feature gating and the digest budget, never a hardcode. */
export type Capabilities = {
  /** Can be asked for JSON and usually complies. */
  structured: boolean;
  /** Can emit tokens as they are produced. */
  streaming: boolean;
  /** Can read the repository while answering. */
  repoTools: boolean;
  models: { fast?: string; smart?: string; deep?: string };
  /** How much input it will take, which is what the digest is budgeted against. */
  maxInputChars: number;
};

export type Tier = 'fast' | 'smart' | 'deep';

/**
 * Tools are named by capability, not by product.
 *
 * `Read`, `Grep` and `Glob` are one CLI's names for them. A request asks for `readFile` and
 * each adapter maps it to whatever it actually has — or says it has none, and the feature
 * degrades visibly instead of quietly getting worse.
 */
export type ToolCapability = 'readFile' | 'search' | 'listFiles';

export type Request = {
  tier: Tier;
  /** Plain prose and a JSON contract. No provider dialect, ever. */
  system: string;
  input: string;
  tools?: readonly ToolCapability[];
  cwd?: string;
  session?: { id: string; resume?: boolean };
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
};

export type Answer = {
  text: string;
  usage: Usage;
  model: string;
  /** A handle for continuing this conversation, when the provider offers one. */
  session?: string;
};

/**
 * What arrives while an answer is being written.
 *
 * Tool calls are surfaced rather than hidden: a pause with `Grep isExpired` under it has a
 * visible reason, and a reviewer can see what the answer was actually based on.
 */
export type Chunk = { kind: 'text'; text: string } | { kind: 'tool'; label: string };

export class ProviderError extends Error {
  constructor(
    readonly kind: 'not-installed' | 'not-authenticated' | 'timeout' | 'cancelled' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface Provider {
  readonly id: string;
  capabilities(): Capabilities;
  /** Installed *and* signed in — a provider that cannot answer is not available. */
  available(): Promise<{ ok: boolean; reason?: string }>;
  structured(request: Request, signal: AbortSignal): Promise<Answer>;
  /** Present when `capabilities().streaming`; chunks arrive as they are produced. */
  stream?(request: Request, signal: AbortSignal, onChunk: (chunk: Chunk) => void): Promise<Answer>;
}

const providers = new Map<string, Provider>();

export function register(provider: Provider): void {
  providers.set(provider.id, provider);
}

export function get(id: string): Provider | undefined {
  return providers.get(id);
}

export function all(): Provider[] {
  return [...providers.values()];
}
