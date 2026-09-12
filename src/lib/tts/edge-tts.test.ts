import { describe, expect, it } from "vitest";
import { ANDREW_NEURAL_VOICE_ID } from "./standard-voice";
import {
  buildEdgeSsml,
  edgeRateFromSpeed,
  escapeEdgeSsmlText,
  extractEdgeAudioPayload,
  generateSecMsGec,
  isEdgeTurnEnd,
  synthesizeEdgeTts,
  type EdgeSocketHandlers,
} from "./edge-tts";

describe("Edge TTS protocol helpers", () => {
  it("generates a deterministic Sec-MS-GEC token", () => {
    const a = generateSecMsGec({ nowMs: 1_700_000_000_000, clockSkewSeconds: 0 });
    const b = generateSecMsGec({ nowMs: 1_700_000_000_000, clockSkewSeconds: 0 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9A-F]{64}$/);

    const skewed = generateSecMsGec({
      nowMs: 1_700_000_000_000,
      clockSkewSeconds: 600,
    });
    expect(skewed).not.toBe(a);
  });

  it("escapes SSML and pins Andrew Neural", () => {
    const ssml = buildEdgeSsml(`Tom & Jerry <3`, ANDREW_NEURAL_VOICE_ID, {
      rate: "+0%",
    });
    expect(ssml).toContain(`name="${ANDREW_NEURAL_VOICE_ID}"`);
    expect(ssml).toContain("Tom &amp; Jerry &lt;3");
    expect(ssml).not.toContain("Tom & Jerry");
    expect(escapeEdgeSsmlText(`a"b'`)).toBe("a&quot;b&apos;");
  });

  it("maps playback speed to Edge prosody rate", () => {
    expect(edgeRateFromSpeed(1)).toBe("+0%");
    expect(edgeRateFromSpeed(1.1)).toBe("+10%");
    expect(edgeRateFromSpeed(0.85)).toBe("-15%");
  });

  it("extracts audio after the Path:audio delimiter", () => {
    const payload = Buffer.from("ID3fake-mp3");
    const frame = Buffer.concat([
      Buffer.from("X-RequestId:abc\r\nPath:audio\r\n"),
      payload,
    ]);
    expect(extractEdgeAudioPayload(frame)?.equals(payload)).toBe(true);
    expect(extractEdgeAudioPayload(Buffer.from("nope"))).toBeNull();
    expect(isEdgeTurnEnd("Path:turn.end\r\n")).toBe(true);
  });

  it("synthesizes from an injected websocket and never picks another voice", async () => {
    const sent: string[] = [];
    const audio = Buffer.from("ID3edge-audio");
    const result = await synthesizeEdgeTts({
      text: "Hello from Standard.",
      voice: ANDREW_NEURAL_VOICE_ID,
      openSocket: (_url, _headers, handlers: EdgeSocketHandlers) => {
        queueMicrotask(() => {
          handlers.onOpen();
          handlers.onMessage(
            Buffer.concat([Buffer.from("Path:audio\r\n"), audio])
          );
          handlers.onMessage("Path:turn.end");
        });
        return {
          send: (data) => sent.push(data),
          close: () => undefined,
        };
      },
    });

    expect(result.equals(audio)).toBe(true);
    expect(sent.join("\n")).toContain(ANDREW_NEURAL_VOICE_ID);
    expect(sent.join("\n")).toContain("Hello from Standard.");
    expect(sent.join("\n")).not.toMatch(/fish-narrator|00a1b221/i);
  });

  it("fails closed when the socket yields no audio", async () => {
    await expect(
      synthesizeEdgeTts({
        text: "silence",
        openSocket: (_url, _headers, handlers) => {
          queueMicrotask(() => {
            handlers.onOpen();
            handlers.onMessage("Path:turn.end");
          });
          return { send: () => undefined, close: () => undefined };
        },
      })
    ).rejects.toThrow(/no audio/i);
  });
});
