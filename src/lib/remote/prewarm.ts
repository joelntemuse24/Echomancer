/**
 * One short S2 prewarm. A second click inside the hold joins the first
 * flight and does not start another container. This does not run `::cover`
 * (that RPC is allowed to compile for up to 20 minutes). The child is the
 * restore-only `prewarm` entrypoint, which cancels its own RPC on timeout.
 * The flight stays open until that process exits. min_containers stays 0.
 * Vitest never spawns the process.
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
  if (admitted.kind === "join") return "ready";
  if (admitted.kind === "blocked") return "ready";
  const configured = Boolean(
    process.env.MODAL_TOKEN_ID?.trim() || process.env.MODAL_S2_WARM_CMD?.trim()
  );
  if (!configured || process.env.VITEST) {
    admitted.finish("failure", configured ? "vitest" : "unconfigured");
    return "unconfigured";
  }
  const child = spawn(
    "python3",
    ["-m", "modal", "run", "--quiet", "modal/s2_clone_warm.py::prewarm"],
    { stdio: "ignore" }
  );
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGTERM"), 100_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve(status ?? 1);
    });
  });
  if (code !== 0) {
    admitted.finish("failure", `exit ${code}`);
    return "unconfigured";
  }
  admitted.finish("success");
  return "ready";
}
