import { describe, expect, it } from "vitest";
import {
  assertBareCpuEndpoint,
  assertDeletableSmokeKey,
  assertDispatchTaskId,
  assertSmokeRunId,
  smokeRunIdFromBytes,
  smokeStoragePrefix,
} from "@/lib/cpu/smoke-id";

const ID = smokeRunIdFromBytes(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));

describe("cpu smoke ids", () => {
  it("builds a synthetic id and refuses anything else", () => {
    expect(ID).toBe("cpusmoke0001020304050607");
    assertSmokeRunId(ID);
    expect(() => assertSmokeRunId("job-customer")).toThrow(/refusing/);
    expect(() => assertSmokeRunId(`${ID}ff`)).toThrow(/refusing/);
    expect(() => smokeRunIdFromBytes(new Uint8Array(7))).toThrow(/8 bytes/);
  });

  it("deletes only keys under that run's audiobooks prefix", () => {
    const prefix = smokeStoragePrefix(ID);
    expect(prefix).toBe(`audiobooks/${ID}/`);
    assertDeletableSmokeKey(ID, `${prefix}sections/0000.mp3`);
    expect(() => assertDeletableSmokeKey(ID, "audiobooks/other/full.mp3")).toThrow(/refusing/);
    expect(() => assertDeletableSmokeKey(ID, `${prefix}../full.mp3`)).toThrow(/refusing/);
    expect(() => assertDeletableSmokeKey(ID, `audiobooks/${ID}extra/full.mp3`)).toThrow(
      /refusing/
    );
  });

  it("dispatches only this run's master and concat tasks", () => {
    expect(assertDispatchTaskId(`master:${ID}:0`)).toBe(ID);
    expect(assertDispatchTaskId(`master:${ID}:1`)).toBe(ID);
    expect(assertDispatchTaskId(`concat:${ID}`)).toBe(ID);
    expect(() => assertDispatchTaskId("master:customer:0")).toThrow(/refusing/);
    expect(() => assertDispatchTaskId(`whisper:${ID}:0`)).toThrow(/refusing/);
    expect(assertDispatchTaskId(`master:${ID}:2`)).toBe(ID);
    expect(() => assertDispatchTaskId(`master:${ID}:3`)).toThrow(/refusing/);
  });

  it("rejects an endpoint URL that has a path", () => {
    expect(assertBareCpuEndpoint("https://example.modal.run")).toBe("https://example.modal.run");
    expect(assertBareCpuEndpoint("https://example.modal.run/")).toBe("https://example.modal.run");
    expect(() => assertBareCpuEndpoint("https://example.modal.run/run")).toThrow(/no path/);
    expect(() => assertBareCpuEndpoint("https://example.modal.run?x=1")).toThrow(/no query/);
  });
});
