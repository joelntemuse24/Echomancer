/**
 * Remaster verified raw takes for one failed book. Offline. Does not
 * synthesize, does not call Modal, and does not change a workspace budget.
 *
 * Dry-run (no writes) is the default:
 *   npx tsx scripts/repair-raw-masters.ts --job <jobId>
 *
 * Apply only after backups, and only when usage is allowed again:
 *   npx tsx scripts/repair-raw-masters.ts --job <jobId> --apply --confirm-service-available
 *
 * Or, instead of Modal, master on this machine. That flag is an explicit
 * approval. The worker does not set it by itself:
 *   npx tsx scripts/repair-raw-masters.ts --job <jobId> --apply --approve-local
 *
 * Final concat is queued only when every section is ready or covered by a
 * verified raw object. Ready section objects are not rewritten. A missing
 * raw object is listed and left failed. Do not run this while recovery
 * is held.
 */

import { applyRawRemaster, type RawRemasterMode } from "@/lib/cpu/remaster-raw";

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const jobId = arg("--job");
  if (!jobId || jobId.startsWith("--")) {
    console.error("usage: repair-raw-masters --job <jobId> [--apply --confirm-service-available | --apply --approve-local]");
    process.exitCode = 2;
    return;
  }
  const apply = process.argv.includes("--apply");
  const confirm = process.argv.includes("--confirm-service-available");
  const local = process.argv.includes("--approve-local");
  if (apply && confirm === local) {
    console.error("apply requires exactly one of --confirm-service-available or --approve-local");
    process.exitCode = 2;
    return;
  }
  const mode: RawRemasterMode = !apply
    ? "dry-run"
    : local
      ? "approve-local"
      : "service-available";
  const result = await applyRawRemaster({ jobId, mode });
  console.log(JSON.stringify(result, null, 2));
  if (result.missingRaw.length > 0) {
    console.error(`missing raw indexes: ${result.missingRaw.join(",")}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
