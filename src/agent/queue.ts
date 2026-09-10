export type Job<T> = (signal: AbortSignal) => Promise<T>;

/**
 * Runs model requests a few at a time, and can drop all of them at once.
 *
 * Every job belongs to the review that asked for it. Closing a review kills them all —
 * queued ones are dropped, running ones are signalled — because a review that is gone must
 * not leave a subprocess behind talking to the user's account.
 */
export class Queue {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly owners = new Map<string, Set<AbortController>>();

  constructor(private readonly concurrency: number) {}

  get inFlight(): number {
    return this.running;
  }

  async run<T>(owner: string, job: Job<T>): Promise<T> {
    const controller = new AbortController();
    const owned = this.owners.get(owner) ?? new Set();
    owned.add(controller);
    this.owners.set(owner, owned);

    try {
      await this.acquire();
      // Cancelled while it sat in the queue: never start it at all.
      if (controller.signal.aborted) throw new DOMException('cancelled', 'AbortError');
      return await job(controller.signal);
    } finally {
      owned.delete(controller);
      if (owned.size === 0) this.owners.delete(owner);
      this.release();
    }
  }

  cancel(owner: string): void {
    for (const controller of this.owners.get(owner) ?? []) controller.abort();
    this.owners.delete(owner);
  }

  cancelAll(): void {
    for (const owner of [...this.owners.keys()]) this.cancel(owner);
  }

  private async acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running += 1;
  }

  private release(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }
}
