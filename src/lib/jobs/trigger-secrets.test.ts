import { afterEach, describe, expect, it } from "vitest";
import { assertTakehomeWorkerSecrets } from "./trigger-secrets";

const KEYS = [
  "FISH_API_KEY",
  "FISH_AUDIO_API_KEY",
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "STORAGE_PATH",
  "INTERNAL_JOB_SECRET",
  "VERCEL",
  "TRIGGER",
  "WORKER",
  "TRIGGER_SECRET_KEY",
  "NODE_ENV",
] as const;

describe("assertTakehomeWorkerSecrets", () => {
  const snapshot = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of KEYS) {
      if (snapshot.has(key)) {
        const value = snapshot.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
        snapshot.delete(key);
      }
    }
  });

  function setEnv(key: (typeof KEYS)[number], value: string | undefined) {
    if (!snapshot.has(key)) snapshot.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it("allows Standard Whole-book without a Fish key", () => {
    setEnv("FISH_API_KEY", undefined);
    setEnv("FISH_AUDIO_API_KEY", undefined);
    setEnv("TURSO_DATABASE_URL", ":memory:");
    setEnv("STORAGE_PATH", "/tmp/echomancer-test");
    setEnv("VERCEL", undefined);
    setEnv("TRIGGER", undefined);
    setEnv("WORKER", undefined);
    setEnv("TRIGGER_SECRET_KEY", undefined);
    setEnv("NODE_ENV", "test");
    expect(() => assertTakehomeWorkerSecrets()).not.toThrow();
  });
});
