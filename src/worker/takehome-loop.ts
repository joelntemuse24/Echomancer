/**
 * In-process Whole-book runner for the always-on VM.
 *
 * Turso is the queue. This loop claims work via existing leases in
 * `process-job` and never runs the same jobId twice at once.
 */

export interface TakehomeRunResult {
  status: string;
}

export interface TakehomeRunner {
  runUntilSettled: (
    jobId: string,
    budgetMs: number
  ) => Promise<TakehomeRunResult>;
  listDrainable: (limit?: number) => Promise<string[]>;
  releaseExpired: () => Promise<number>;
}

export interface TakehomeWorkerLoopOptions {
  concurrency: number;
  budgetMs: number;
  runner: TakehomeRunner;
  drainLimit?: number;
  log?: Pick<typeof console, "info" | "error">;
}

export class TakehomeWorkerLoop {
  private readonly inflight = new Map<string, Promise<void>>();
  private drainInFlight: Promise<{ started: string[]; released: number }> | null =
    null;
  private stopped = false;
  private readonly log: Pick<typeof console, "info" | "error">;

  constructor(private readonly opts: TakehomeWorkerLoopOptions) {
    this.log = opts.log ?? console;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  get concurrency(): number {
    return Math.max(1, this.opts.concurrency);
  }

  isInflight(jobId: string): boolean {
    return this.inflight.has(jobId);
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Try to start `jobId` now. Returns whether a new run began.
   * Already-running jobs and a full slot table are no-ops — Turso still
   * holds the row for a later drain.
   */
  enqueue(jobId: string): boolean {
    if (this.stopped) return false;
    if (!jobId) return false;
    if (this.inflight.has(jobId)) return false;
    if (this.inflight.size >= this.concurrency) return false;
    this.start(jobId);
    return true;
  }

  async drain(): Promise<{ started: string[]; released: number }> {
    if (this.stopped) return { started: [], released: 0 };
    if (this.drainInFlight) return this.drainInFlight;
    this.drainInFlight = this.drainOnce().finally(() => {
      this.drainInFlight = null;
    });
    return this.drainInFlight;
  }

  private async drainOnce(): Promise<{ started: string[]; released: number }> {
    if (this.stopped) return { started: [], released: 0 };
    const released = await this.opts.runner.releaseExpired();
    if (this.inflight.size >= this.concurrency) {
      return { started: [], released };
    }
    const ids = await this.opts.runner.listDrainable(this.opts.drainLimit ?? 50);
    const started: string[] = [];
    for (const id of ids) {
      if (this.stopped) break;
      if (this.inflight.size >= this.concurrency) break;
      if (this.inflight.has(id)) continue;
      this.start(id);
      started.push(id);
    }
    return { started, released };
  }

  async waitIdle(timeoutMs = 30_000): Promise<void> {
    const pending = [...this.inflight.values()];
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private start(jobId: string): void {
    if (this.inflight.has(jobId)) return;
    const run = this.opts.runner
      .runUntilSettled(jobId, this.opts.budgetMs)
      .then((result) => {
        this.log.info(
          `[takehome-worker] job ${jobId} settled status=${result.status}`
        );
      })
      .catch((err) => {
        this.log.error(`[takehome-worker] job ${jobId} failed`, err);
      })
      .finally(() => {
        this.inflight.delete(jobId);
        if (!this.stopped) {
          void this.drain();
        }
      });
    this.inflight.set(jobId, run);
  }
}
