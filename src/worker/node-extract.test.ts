import { afterEach, describe, expect, it, vi } from "vitest";
import { requestListenPrepHandoff } from "@/worker/extract-ipc";
import {
  extractChildExecArgv,
  installExtractChildSpawner,
  resetNodeExtractForTests,
  setExtractListenPrepHandler,
  startNodeExtract,
} from "@/worker/node-extract";

describe("extractChildExecArgv", () => {
  afterEach(() => {
    delete process.env.EXTRACT_CHILD_MEMORY_MB;
  });

  it("adds the tsx loader when the parent was not started with one", () => {
    expect(extractChildExecArgv([])).toEqual(["--import", "tsx"]);
  });

  it("keeps an existing tsx loader and drops the inspector", () => {
    expect(
      extractChildExecArgv(["--import", "tsx", "--inspect=9229"])
    ).toEqual(["--import", "tsx"]);
  });

  it("keeps a heap cap the parent was started with", () => {
    process.env.EXTRACT_CHILD_MEMORY_MB = "2048";
    expect(
      extractChildExecArgv(["--import", "tsx", "--max-old-space-size=768"])
    ).toEqual(["--import", "tsx", "--max-old-space-size=768"]);
  });

  it("adds an old-space cap when the parent did not set one", () => {
    process.env.EXTRACT_CHILD_MEMORY_MB = "640";
    expect(extractChildExecArgv(["--import", "tsx"])).toEqual([
      "--import",
      "tsx",
      "--max-old-space-size=640",
    ]);
  });
});

class FakeChild {
  sent: unknown[] = [];
  killed = false;
  pid = 41;
  private listeners = new Map<string, Array<(payload?: unknown) => void>>();

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }

  on(event: "message", listener: (message: unknown) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  once(event: "exit", listener: (code: number | null) => void): this {
    const wrapped = (payload?: unknown) => {
      const list = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        list.filter((item) => item !== wrapped)
      );
      listener((payload as number | null) ?? null);
    };
    const list = this.listeners.get(event) ?? [];
    list.push(wrapped);
    this.listeners.set(event, list);
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emit(event: string, payload?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(payload);
    }
  }
}

describe("warm extract child", () => {
  const children: FakeChild[] = [];

  afterEach(() => {
    resetNodeExtractForTests();
    children.length = 0;
  });

  function install() {
    installExtractChildSpawner(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
  }

  it("reuses one warm child and hands listen-prep to the parent before the next book", () => {
    install();
    const prep: string[] = [];
    setExtractListenPrepHandler((uploadId) => {
      prep.push(uploadId);
    });

    expect(startNodeExtract("upload-1")).toEqual({
      started: false,
      queued: true,
    });
    expect(children).toHaveLength(1);
    children[0]!.emit("message", { type: "ready" });
    expect(children[0]!.sent).toContainEqual({
      type: "extract",
      uploadId: "upload-1",
      requestId: 1,
    });

    children[0]!.emit("message", {
      type: "listen-prep",
      uploadId: "upload-1",
      requestId: 1,
    });
    expect(prep).toEqual(["upload-1"]);
    expect(children[0]!.sent).toContainEqual({
      type: "listen-prep-ack",
      requestId: 1,
    });

    children[0]!.emit("message", {
      type: "done",
      requestId: 1,
      status: "ready",
      charCount: 20,
      heapMb: 40,
    });
    expect(startNodeExtract("upload-2").started).toBe(true);
    expect(children).toHaveLength(1);
    expect(children[0]!.sent).toContainEqual({
      type: "extract",
      uploadId: "upload-2",
      requestId: 2,
    });
    expect(children[0]!.killed).toBe(false);
  });

  it("replaces a child whose heap is past the recycle line", () => {
    install();
    startNodeExtract("upload-1");
    children[0]!.emit("message", { type: "ready" });
    children[0]!.emit("message", {
      type: "done",
      requestId: 1,
      heapMb: 2048,
    });
    expect(children[0]!.killed).toBe(true);
    expect(children).toHaveLength(2);
    expect(children[1]!.killed).toBe(false);
  });
});

describe("requestListenPrepHandoff", () => {
  it("resolves on the parent ack without running the fallback", async () => {
    const sent: unknown[] = [];
    const fallback = vi.fn(async () => {});
    let settle: (() => void) | null = null;
    const done = requestListenPrepHandoff({
      uploadId: "u",
      requestId: 7,
      send: (message) => {
        sent.push(message);
        return true;
      },
      onAck: (_id, fn) => {
        settle = fn;
      },
      fallback,
      timeoutMs: 50,
    });
    settle!();
    await done;
    expect(sent).toEqual([
      { type: "listen-prep", uploadId: "u", requestId: 7 },
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("runs the fallback when the parent never acks", async () => {
    const fallback = vi.fn(async () => {});
    await requestListenPrepHandoff({
      uploadId: "u",
      requestId: 3,
      send: () => true,
      onAck: () => {},
      fallback,
      timeoutMs: 5,
    });
    expect(fallback).toHaveBeenCalledWith("u");
  });
});
