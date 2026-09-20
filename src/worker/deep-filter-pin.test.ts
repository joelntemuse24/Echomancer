import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const X64_MUSL_SHA =
  "70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da";
const ARM64_GNU_SHA =
  "14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166";
const VERSION = "0.5.6";

function readRepo(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

describe("DeepFilterNet pin (Oracle + Docker + Trigger)", () => {
  it("keeps the same 0.5.6 checksums on the Oracle installer and Dockerfile", () => {
    const install = readRepo("scripts/oracle/install-oracle.sh");
    const docker = readRepo("workers/takehome/Dockerfile");
    const trigger = readRepo("trigger.config.ts");

    for (const source of [install, docker]) {
      expect(source).toContain(VERSION);
      expect(source).toContain(X64_MUSL_SHA);
      expect(source).toContain(ARM64_GNU_SHA);
      expect(source).toContain(
        `deep-filter-${VERSION}-aarch64-unknown-linux-gnu`
      );
    }

    expect(trigger).toContain(VERSION);
    expect(trigger).toContain(X64_MUSL_SHA);
    expect(trigger).toContain(
      `deep-filter-${VERSION}-x86_64-unknown-linux-musl`
    );
  });

  it("documents loopback bind and smoke endpoints in the pm2 / smoke files", () => {
    const ecosystem = readRepo("scripts/oracle/ecosystem.config.cjs");
    const smoke = readRepo("scripts/oracle/smoke-worker.sh");
    expect(ecosystem).toContain('WORKER_HOST: "127.0.0.1"');
    expect(ecosystem).toContain("echomancer-takehome");
    expect(smoke).toContain("/health");
    expect(smoke).toContain("/ready");
    expect(smoke).toContain("/jobs");
  });
});
