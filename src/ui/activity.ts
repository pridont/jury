import * as vscode from 'vscode';

/**
 * What the extension is doing, while it is doing it.
 *
 * Everything the model does runs behind an already-usable review, which is the right trade —
 * but silence for forty seconds reads as nothing happening. This says what is in flight in
 * two places: above the tree for someone looking at it, and in the status bar for someone
 * who is not.
 */
export class Activity implements vscode.Disposable {
  private done = 0;
  private total = 0;
  private phase = '';
  private report: ((value: { message: string }) => void) | null = null;
  private finish: (() => void) | null = null;

  constructor(private readonly view: { message?: string | undefined }) {}

  /** Begin a phase. Ends the previous one if it was still open. */
  start(phase: string, total = 0): void {
    this.phase = phase;
    this.total = total;
    this.done = 0;
    this.paint();

    if (this.finish) return;
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Change Stack' },
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
    this.phase = '';
    this.view.message = '';
    this.finish?.();
    this.finish = null;
    this.report = null;
  }

  dispose(): void {
    this.stop();
  }

  private paint(): void {
    if (!this.phase) return;
    const text = this.text();
    this.view.message = text;
    this.report?.({ message: text });
  }

  private text(): string {
    return this.total > 0 ? `${this.phase} — ${this.done}/${this.total}` : this.phase;
  }
}
