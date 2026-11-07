/**
 * The host CPU cap is full. The take is already stored as a raw object.
 * Callers queue the task and must not mark the section ready.
 */
export class CpuSaturatedError extends Error {
  readonly kind: "ffmpeg" | "whisper" | "extract";

  constructor(kind: "ffmpeg" | "whisper" | "extract") {
    super(`cpu ${kind} capacity is in use`);
    this.name = "CpuSaturatedError";
    this.kind = kind;
  }
}

/**
 * CPU work is queued on another tick or another host. The book goes back
 * to `queued`. It is not failed and it is not published.
 */
export class CpuBacklogError extends Error {
  constructor() {
    super("cpu work is queued");
    this.name = "CpuBacklogError";
  }
}
