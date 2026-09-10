import * as vscode from 'vscode';
import type { SessionHost } from '../session.js';
import type { Navigator } from './nav.js';
import { askPrompt } from '../agent/prompts/ask.js';
import { ProviderError, type Chunk, type Provider } from '../agent/provider.js';
import type { Entry } from '../model/order.js';

export type ChatDeps = {
  host: SessionHost;
  nav: Navigator;
  provider: () => Promise<Provider | null>;
  log: (line: string) => void;
};

/**
 * `@changestack` — questions about the change being read.
 *
 * The chat view rather than a window of our own: streaming, follow-ups, markdown, code links
 * and cancellation all already work there, and a reviewer already knows how to use it.
 *
 * The scope is whatever the cursor is on. A question with no review open, or with nothing
 * selected, says so instead of answering about nothing.
 */
export function registerChat(deps: ChatDeps): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant('changestack.ask', async (request, context, stream, token) => {
    const session = deps.host.active;
    if (!session) {
      stream.markdown('No review is open. Run **Change Stack: Review Working Tree** first.');
      return;
    }

    const entry = deps.nav.current;
    if (!entry) {
      stream.markdown('Nothing is selected in the review yet. Open a change and ask again.');
      return;
    }

    const provider = await deps.provider();
    if (!provider) {
      stream.markdown('No model provider is available. `Change Stack: Doctor` says why.');
      return;
    }
    if (!provider.stream) {
      stream.markdown(`\`${provider.id}\` cannot stream an answer.`);
      return;
    }

    const wide = request.command === 'step';
    const resume = continuing(context) ? sessions.get(session.id) : undefined;
    if (!resume) sessions.delete(session.id);

    stream.progress(resume ? 'Thinking' : `Reading ${scopeName(entry, wide)}`);

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());

    try {
      const answer = await provider.stream(
        {
          tier: 'smart',
          system: askPrompt.system,
          input: resume ? request.prompt : `${context_(entry, wide)}\n\nQuestion: ${request.prompt}`,
          // Read-only by design: a review tool must never edit the code it is reviewing.
          tools: provider.capabilities().repoTools ? ['readFile', 'search', 'listFiles'] : [],
          cwd: session.repo.root,
          ...(resume ? { session: { id: resume, resume: true } } : {}),
        },
        controller.signal,
        (chunk: Chunk) => {
          if (chunk.kind === 'text') stream.markdown(chunk.text);
          else stream.progress(chunk.label);
        },
      );

      if (answer.session) sessions.set(session.id, answer.session);
      deps.log(
        `  ask: ${answer.usage.inputTokens} in, ${answer.usage.outputTokens} out, ` +
          `${answer.usage.durationMs}ms, $${answer.usage.costUsd.toFixed(4)}${resume ? ' (resumed)' : ''}`,
      );

      if (!provider.capabilities().repoTools) {
        stream.markdown(
          `\n\n_\`${provider.id}\` cannot read the repository, so this answer is from the diff alone._`,
        );
      }
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'cancelled') return;
      const reason = error instanceof Error ? error.message : String(error);
      deps.log(`  ask failed: ${reason}`);
      stream.markdown(`\n\nThat question could not be answered: ${reason}`);
    }
  });

  participant.iconPath = new vscode.ThemeIcon('layers');
  participant.followupProvider = {
    provideFollowups: () => [
      { prompt: 'What else in the repository depends on this?', label: 'What depends on this?' },
      { prompt: 'What could this break?', label: 'What could this break?' },
    ],
  };

  return participant;
}

/** Conversation handles per review, so a follow-up resumes instead of resending the diff. */
const sessions = new Map<string, string>();

export function forgetSessions(): void {
  sessions.clear();
}

/** A request with history behind it is a follow-up; the model still has the diff. */
function continuing(context: vscode.ChatContext): boolean {
  return context.history.length > 0;
}

function scopeName(entry: Entry, wide: boolean): string {
  return wide ? entry.layer.title : `${entry.hunk.path}:${entry.hunk.newStart}`;
}

/** What the model is asked about: this hunk, or the whole step it belongs to. */
function context_(entry: Entry, wide: boolean): string {
  const lines: string[] = [`Change being reviewed: ${entry.cohort.title}`, entry.cohort.summary, ''];

  if (wide) {
    lines.push(`Step: ${entry.layer.title}`, entry.layer.summary, `Files: ${entry.layer.paths.join(', ')}`, '');
  }

  lines.push(`Hunk in ${entry.hunk.path}${entry.hunk.symbol ? `, in ${entry.hunk.symbol}` : ''}:`);
  lines.push(`@@ -${entry.hunk.oldStart},${entry.hunk.oldCount} +${entry.hunk.newStart},${entry.hunk.newCount} @@`);
  lines.push(...entry.hunk.lines);

  return lines.join('\n');
}
