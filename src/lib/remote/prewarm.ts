/**
 * One short S2 prewarm. A second click inside the hold joins the first
 * flight and does not start another container. This does not run `::cover`
 * (that RPC is allowed to compile for up to 20 minutes). min_containers
 * stays 0. Vitest never spawns the process.
 */

import { spawn } from "node:child_process";
import { admitRemoteCall } from "@/lib/remote/layer";

export async function prewarmS2Clone(): Promise<"ready" | "unconfigured"> {
  const admitted = admitRemoteCall({
    provider: "prewarm",
    path: "warm",
    sections: ["s2"],
    estMs: 90_000,
    estCostUsd: 0.1,
  });
  if (admitted.kind !== "start") return "ready";
  const configured = Boolean(
    process.env.MODAL_TOKEN_ID?.trim() || process.env.MODAL_S2_WARM_CMD?.trim()
  );
  if (!configured || process.env.VITEST) {
    admitted.finish(configured ? "success" : "failure", configured ? undefined : "unconfigured");
    return configured && !process.env.VITEST ? "ready" : "unconfigured";
  }
  const child = spawn(
    "python3",
    ["-m", "modal", "run", "--quiet", "modal/s2_clone_warm.py::prewarm"],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  admitted.finish("success");
  return "ready";
}
