import * as vscode from 'vscode';

/** Which loading icon fits the work: reading the diff, writing an answer, or grouping. */
export type ActivityKind = 'scanning' | 'answering' | 'deliberating';

/**
 * What the extension is doing, while it is doing it.
 *
 * Model work runs behind a review that is already usable, so without this it would look like
 * nothing is happening. The tree shows the current step with its loading icon, and the status
 * bar shows it for someone looking elsewhere.
 */
export class Activity implements vscode.Disposable {
  private done = 0;
  private total = 0;
  private phase = '';
  private kind: ActivityKind = 'deliberating';
  private report: ((value: { message: string }) => void) | null = null;
  private finish: (() => void) | null = null;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  /** The step in progress, or null when nothing is running. */
  get current(): { text: string; kind: ActivityKind } | null {
    return this.phase ? { text: this.text(), kind: this.kind } : null;
  }

  /** Begin a step. Replaces the previous one if it was still open. */
  start(phase: string, total = 0, kind: ActivityKind = 'deliberating'): void {
    this.phase = phase;
    this.total = total;
    this.done = 0;
    this.kind = kind;
    this.paint();

    if (this.finish) return;
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Jury' },
      (progress) =>
        new Promise<void>((resolve) => {
          this.report = (value) => progress.report(value);
          this.finish = resolve;
          this.report({ message: this.text() });
        }),
    );
  }

  step(): void {
    this.done += 1;
    this.paint();
  }

  stop(): void {
    if (!this.phase && !this.finish) return;
    this.phase = '';
    this.finish?.();
    this.finish = null;
    this.report = null;
    this.changed.fire();
  }

  dispose(): void {
    this.stop();
    this.changed.dispose();
  }

  private paint(): void {
    if (!this.phase) return;
    this.report?.({ message: this.text() });
    this.changed.fire();
  }

  private text(): string {
    return this.total > 0 ? `${this.phase} (${this.done}/${this.total})` : this.phase;
  }
}
