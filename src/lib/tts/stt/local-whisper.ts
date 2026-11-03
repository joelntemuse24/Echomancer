/**
 * Self-hosted Whisper transcription for QA, via `scripts/whisper-qa.py`.
 *
 * Why a child process rather than a Node binding: `faster-whisper` is the
 * best-maintained CPU Whisper and it is Python. Running it as a sidecar keeps
 * the model out of the Node heap, lets the OS reclaim it between books, and
 * means a wedged transcription is killed by killing the child.
 *
 * Node-only. The Cloudflare extract Worker never imports this (QA runs on the
 * take-home worker, and `transcript-qa` is only reached from `process-job`).
 *
 * Measured on the 4-vCPU worker class, `base` int8:
 *   RTF 0.02–0.03 wall, 0.067–0.077 CPU-minutes per audio-minute
 *   ~5% WER on neural TTS, 2–6% on long full-size sections
 * which is roughly 50x faster than realtime and comfortably keeps up with Edge
 * synthesis at ~3.8 audio-seconds per wall-second.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type WhisperResult =
  | { ok: true; text: string; audioSec: number | null; sttSec: number | null; model: string | null }
  | { ok: false; error: string };

const SCRIPT_NAME = "whisper-qa.py";

/** Overridable for tests and for an unusual deployment layout. */
export function whisperScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TTS_QA_WHISPER_SCRIPT?.trim();
  if (explicit) return explicit;
  return path.join(process.cwd(), "scripts", SCRIPT_NAME);
}

export function whisperPython(env: NodeJS.ProcessEnv = process.env): string {
  return env.TTS_QA_WHISPER_PYTHON?.trim() || "python3";
}

/** True when the sidecar script is on disk. */
export function localWhisperAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return existsSync(whisperScriptPath(env));
  } catch {
    return false;
  }
}

/**
 * Transcribe one audio buffer. Resolves `{ok:false}` rather than throwing, so
 * a missing interpreter or model keeps the audio and never stops a book.
 */
export function transcribeWithLocalWhisper(
  audio: Buffer,
  env: NodeJS.ProcessEnv = process.env,
  waitMs = 30_000
): Promise<WhisperResult> {
  const script = whisperScriptPath(env);
  if (!existsSync(script)) {
    return Promise.resolve({ ok: false, error: "whisper sidecar not found" });
  }

  return new Promise<WhisperResult>((resolve) => {
    let settled = false;
    const finish = (value: WhisperResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(whisperPython(env), [script], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      // Keep the tail only; a stack trace can be long.
      errOut.push(chunk);
      if (errOut.length > 32) errOut.shift();
    });
    child.on("error", (err) => finish({ ok: false, error: err.message }));
    child.on("close", () => {
      const raw = Buffer.concat(out).toString("utf8").trim();
      if (!raw) {
        const tail = Buffer.concat(errOut).toString("utf8").trim().slice(-300);
        finish({ ok: false, error: tail || "whisper produced no output" });
        return;
      }
      try {
        const parsed = JSON.parse(raw) as {
          ok?: boolean;
          text?: string;
          error?: string;
          audioSec?: number;
          sttSec?: number;
          model?: string;
        };
        if (parsed.ok && typeof parsed.text === "string") {
          finish({
            ok: true,
            text: parsed.text,
            audioSec: typeof parsed.audioSec === "number" ? parsed.audioSec : null,
            sttSec: typeof parsed.sttSec === "number" ? parsed.sttSec : null,
            model: typeof parsed.model === "string" ? parsed.model : null,
          });
          return;
        }
        finish({ ok: false, error: parsed.error || "whisper failed" });
      } catch {
        finish({ ok: false, error: "whisper output was not JSON" });
      }
    });

    const timer = setTimeout(
      () => finish({ ok: false, error: "whisper budget" }),
      Math.max(1_000, waitMs)
    );

    child.stdin?.on("error", () => {
      /* EPIPE when the child dies early; the close handler reports it. */
    });
    child.stdin?.end(audio);
  });
}
