import * as vscode from 'vscode';
import {
  ProviderError,
  type Answer,
  type Capabilities,
  type Chunk,
  type Provider,
  type Request,
  type Tier,
} from '../provider.js';

export type VscodeLmSettings = {
  /** Model ids per tier, matched against what `selectChatModels` offers. */
  models: Partial<Record<Tier, string>>;
};

/**
 * The user's Copilot subscription — or whatever chat models their editor already has.
 *
 * The second adapter, and the reason it exists: an interface designed against one
 * implementation is an interface that fits one implementation. Everything this could not
 * express was changed in the interface rather than worked around here.
 *
 * It found two things. Sessions are one: this API has no conversation handle, so a follow-up
 * resends its context and `Answer.session` is simply absent, which the caller already
 * handles because it is optional. Repository tools are the other — see `capabilities`.
 */
export class VscodeLmProvider implements Provider {
  readonly id = 'vscode-lm';
  private settings: VscodeLmSettings = { models: {} };

  configure(settings: Partial<VscodeLmSettings>): void {
    this.settings = { ...this.settings, ...settings, models: { ...this.settings.models, ...settings.models } };
  }

  capabilities(): Capabilities {
    return {
      structured: true,
      streaming: true,
      // Honest, and load-bearing: asking a model to read the repository here needs a tool
      // loop this adapter does not yet run. Saying false makes Ask answer from the diff
      // alone and say so, which is the visible degradation the design asks for — rather
      // than silently giving worse answers than the other provider.
      repoTools: false,
      models: this.settings.models,
      maxInputChars: 60_000,
    };
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (!vscode.lm?.selectChatModels) {
      return { ok: false, reason: 'this VS Code has no language model API' };
    }
    const models = await vscode.lm.selectChatModels();
    if (models.length === 0) {
      return { ok: false, reason: 'no chat models are available — is Copilot signed in?' };
    }
    return { ok: true };
  }

  async structured(request: Request, signal: AbortSignal): Promise<Answer> {
    return this.send(request, signal, () => {});
  }

  async stream(request: Request, signal: AbortSignal, onChunk: (chunk: Chunk) => void): Promise<Answer> {
    return this.send(request, signal, onChunk);
  }

  private async send(request: Request, signal: AbortSignal, onChunk: (chunk: Chunk) => void): Promise<Answer> {
    const model = await this.pick(request.tier);
    const started = Date.now();

    // No system-prompt channel here, so the instructions lead the conversation instead. The
    // prompts are prose and a JSON shape, which is why they survive the move at all.
    const messages = [
      vscode.LanguageModelChatMessage.User(request.system),
      vscode.LanguageModelChatMessage.User(request.input),
    ];

    const cancellation = new vscode.CancellationTokenSource();
    signal.addEventListener('abort', () => cancellation.cancel(), { once: true });

    let text = '';
    try {
      const response = await model.sendRequest(messages, {}, cancellation.token);
      for await (const fragment of response.text) {
        text += fragment;
        onChunk({ kind: 'text', text: fragment });
      }
    } catch (error) {
      if (signal.aborted) throw new ProviderError('cancelled', 'cancelled');
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof vscode.LanguageModelError && error.code === 'NoPermissions') {
        throw new ProviderError('not-authenticated', message);
      }
      throw new ProviderError('failed', message);
    } finally {
      cancellation.dispose();
    }

    return {
      text,
      model: model.id,
      usage: {
        // This API reports no token counts, so the log says zero rather than a guess.
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: Date.now() - started,
      },
    };
  }

  private async pick(tier: Tier): Promise<vscode.LanguageModelChat> {
    const wanted = this.settings.models[tier];
    const models = await vscode.lm.selectChatModels(wanted ? { id: wanted } : {});
    const model = models[0] ?? (await vscode.lm.selectChatModels())[0];
    if (!model) throw new ProviderError('not-installed', 'no chat model is available');
    return model;
  }
}
