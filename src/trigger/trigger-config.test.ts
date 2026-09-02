/**
 * Trigger Cloud indexes takehome.ts by importing it. That graph loads
 * @libsql/client → libsql, which does require(`@libsql/${currentTarget()}`).
 * On Cloud (Linux x64 glibc) that module is @libsql/linux-x64-gnu — an
 * optionalDependency, not a static import, so the bundler will omit it
 * unless trigger.config.ts installs it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readRepoFile(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("Trigger Cloud libsql native binary", () => {
  const config = readRepoFile("trigger.config.ts");
  const pkg = JSON.parse(readRepoFile("package.json")) as {
    optionalDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("keeps TRIGGER_PROJECT_ID fallback and does not hardcode the dashboard ref", () => {
    expect(config).toMatch(
      /project:\s*process\.env\.TRIGGER_PROJECT_ID\s*\|\|\s*"proj_echomancer"/
    );
    expect(config).not.toMatch(/proj_jtxihwmkgacyxxtkmvkh/);
  });

  it("installs @libsql/linux-x64-gnu via additionalPackages for Cloud indexing", () => {
    expect(config).toMatch(
      /from ["']@trigger\.dev\/build\/extensions\/core["']/
    );
    expect(config).toMatch(/additionalPackages\s*\(/);
    expect(config).toMatch(/@libsql\/linux-x64-gnu/);
  });

  it("leaves @libsql/client and libsql external so the native require resolves", () => {
    expect(config).toMatch(/external:\s*\[/);
    expect(config).toMatch(/["']@libsql\/client["']/);
    expect(config).toMatch(/["']libsql["']/);
  });

  it("records the linux binary as an optionalDependency for version resolution", () => {
    expect(pkg.optionalDependencies?.["@libsql/linux-x64-gnu"]).toBeTruthy();
  });

  it("depends on @trigger.dev/build for the additionalPackages extension", () => {
    expect(pkg.devDependencies?.["@trigger.dev/build"]).toBeTruthy();
  });

  it("installs debian ffmpeg on Trigger only — not torch", () => {
    expect(config).toMatch(/\bffmpeg\s*\(/);
    expect(config).toMatch(/from ["']@trigger\.dev\/build\/extensions\/core["']/);
    expect(config).not.toMatch(/\btorch\b/);
    expect(config).not.toMatch(/deepfilternet@/);
  });

  it("downloads the DeepFilterNet rust deep-filter musl binary into the worker image", () => {
    expect(config).toMatch(/deep-filter-0\.5\.6-x86_64-unknown-linux-musl/);
    expect(config).toMatch(/DEEP_FILTER_BIN/);
    expect(config).toMatch(/Rikorose\/DeepFilterNet/);
  });

  it("pins the linux binary to the same version as libsql in the lockfile", () => {
    const pin = config.match(/@libsql\/linux-x64-gnu@([0-9][0-9A-Za-z._-]*)/);
    expect(pin?.[1]).toBeTruthy();
    const version = pin![1];
    expect(pkg.optionalDependencies?.["@libsql/linux-x64-gnu"]).toBe(version);

    const lock = JSON.parse(readRepoFile("package-lock.json")) as {
      packages: Record<
        string,
        { version?: string; optionalDependencies?: Record<string, string> }
      >;
    };
    const libsql = lock.packages["node_modules/libsql"];
    expect(libsql?.version).toBe(version);
    expect(libsql?.optionalDependencies?.["@libsql/linux-x64-gnu"]).toBe(
      version
    );
  });
});
