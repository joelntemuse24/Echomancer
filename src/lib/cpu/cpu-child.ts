/**
 * One-shot process for CPU task claim tests. The database URL is set
 * before the app import so this process has its own connection.
 *
 *   tsx src/lib/cpu/cpu-child.ts claim <file-url> <taskId>
 */

const mode = process.argv[2];
const url = process.argv[3];
const requestedTask = process.argv[4];

if (!mode || !url || !requestedTask) {
  console.log(JSON.stringify({ error: "missing args" }));
  process.exit(1);
}

const databaseUrl: string = url;
const taskId: string = requestedTask;
process.env.TURSO_DATABASE_URL = databaseUrl;
process.env.VITEST = "1";

async function main(): Promise<void> {
  const { execute } = await import("@/lib/turso");
  await execute("PRAGMA busy_timeout = 5000");
  const { claimCpuTask } = await import("@/lib/cpu/tasks");
  if (mode !== "claim") {
    console.log(JSON.stringify({ error: "unknown mode" }));
    process.exit(1);
  }
  const owner = `proc_${process.pid}_${Date.now()}`;
  const claimed = await claimCpuTask(taskId, owner, 30);
  console.log(JSON.stringify({ claimed, owner }));
}

main().catch((err) => {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});

export {};
