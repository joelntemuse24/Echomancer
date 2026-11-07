/**
 * The executable smoke harness. `--local` runs master and concat on ffmpeg
 * against a temp database. It does not call Modal, R2, or a speech provider.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.join(process.cwd(), "scripts/cpu/smoke-remote.ts");

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("cpu smoke harness", () => {
  it("refuses to run without an explicit mode", async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/usage/);
  });

  it("rejects a remote URL with a path before touching a database", async () => {
    const result = await run(["--confirm-synthetic"], {
      MODAL_CPU_URL: "https://example.modal.run/run",
      MODAL_CPU_TOKEN: "not-sent",
      TURSO_DATABASE_URL: "file:/tmp/cpu-smoke-should-not-open.db",
      R2_ACCOUNT_ID: "x",
      R2_ACCESS_KEY_ID: "x",
      R2_SECRET_ACCESS_KEY: "x",
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/no path/);
    expect(result.stdout).toBe("");
  });

  it("masters, joins, and deletes a synthetic local book", async () => {
    const result = await run(["--local"]);
    const line = result.stdout.trim().split("\n").pop() || "";
    const summary = JSON.parse(line) as {
      ok?: boolean;
      mode?: string;
      runId?: string;
      error?: string;
      checks?: { master1?: { disconnect?: string } };
      cleanup?: { deletedKeys?: string[]; ourJobLeft?: number; foreignJobsDropped?: number };
    };
    expect(summary.error, result.stderr).toBeUndefined();
    expect(summary.ok).toBe(true);
    expect(summary.mode).toBe("local");
    expect(summary.runId).toMatch(/^cpusmoke[0-9a-f]{16}$/);
    expect(summary.checks?.master1?.disconnect).toBe("not-applicable");
    expect(summary.cleanup?.ourJobLeft).toBe(0);
    expect(summary.cleanup?.foreignJobsDropped).toBe(0);
    expect(summary.cleanup?.deletedKeys?.every((key) => key.includes(summary.runId || "missing"))).toBe(
      true
    );
  }, 120_000);
});