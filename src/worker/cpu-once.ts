/**
 * One CPU task, then exit. The Modal CPU container runs this with
 * `CPU_RUNNER=local` so it executes the claim instead of dispatching
 * back to itself. Object keys come from the task row.
 *
 *   node --import tsx src/worker/cpu-once.ts <taskId>
 *
 * Exit 0 done or cancelled, 75 host saturated (queued), 1 failed.
 */

const requested = process.argv[2];
process.env.CPU_RUNNER = "local";

async function main(): Promise<void> {
  if (!requested || requested.startsWith("-")) {
    console.error("usage: cpu-once <taskId>");
    process.exit(2);
  }
  const taskId: string = requested;
  const { runCpuTask } = await import("@/lib/cpu/runner");
  const result = await runCpuTask(taskId);
  if (result === "deferred") process.exit(75);
  if (result === "done" || result === "cancelled") process.exit(0);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

export {};
