import { describe, expect, it } from "vitest";
import { ANDREW_NEURAL_VOICE_ID } from "./standard-voice";
import { FISH_LONG_PAUSE, FISH_SHORT_PAUSE } from "./narration-script";
import {
  EDGE_CHROMIUM_FULL_VERSION,
  EDGE_CHROMIUM_UA,
  EDGE_ORIGIN,
  EDGE_SEC_MS_GEC_VERSION,
  EDGE_TRUSTED_CLIENT_TOKEN,
  EDGE_WSS_URL,
  buildEdgeSsml,
  edgeRateFromSpeed,
  edgeRequestHeaders,
  edgeWebsocketUrl,
  escapeEdgeSsmlText,
  extractEdgeAudioPayload,
  generateSecMsGec,
  isEdgeTurnEnd,
  synthesizeEdgeTts,
  type EdgeSocketHandlers,
} from "./edge-tts";

describe("Edge TTS protocol helpers", () => {
  it("pins Sec-MS-GEC-Version to the working Chromium full build", () => {
    expect(EDGE_CHROMIUM_FULL_VERSION).toBe("143.0.3650.75");
    expect(EDGE_SEC_MS_GEC_VERSION).toBe("1-143.0.3650.75");
    expect(EDGE_SEC_MS_GEC_VERSION).not.toMatch(/3650\.96/);
    expect(EDGE_CHROMIUM_UA).toContain("Chrome/143.0.0.0");
    expect(EDGE_CHROMIUM_UA).toContain("Edg/143.0.0.0");
  });

  it("builds the websocket URL in current edge-tts query order with a lowercase ConnectionId", () => {
    const connectionId = "abcdef0123456789abcdef0123456789";
    const url = edgeWebsocketUrl({
      nowMs: 1_700_000_000_000,
      connectionId,
    });
    expect(url.startsWith(`${EDGE_WSS_URL}?`)).toBe(true);
    expect(url).toContain(`TrustedClientToken=${EDGE_TRUSTED_CLIENT_TOKEN}`);
    expect(url).toContain(`ConnectionId=${connectionId}`);
    expect(url).toContain("Sec-MS-GEC-Version=1-143.0.3650.75");

    const query = url.slice(url.indexOf("?") + 1);
    expect(query.indexOf("TrustedClientToken=")).toBeLessThan(
      query.indexOf("ConnectionId=")
    );
    expect(query.indexOf("ConnectionId=")).toBeLessThan(query.indexOf("Sec-MS-GEC="));
    expect(query.indexOf("Sec-MS-GEC=")).toBeLessThan(
      query.indexOf("Sec-MS-GEC-Version=")
    );
  });

  it("lowercases a ConnectionId that arrives uppercase", () => {
    const url = edgeWebsocketUrl({
      connectionId: "ABCDEF0123456789ABCDEF0123456789",
    });
    expect(url).toContain("ConnectionId=abcdef0123456789abcdef0123456789");
    expect(url).not.toContain("ConnectionId=ABCDEF");
  });

  it("sends Python-matching WSS headers including muid cookie", () => {
    const headers = edgeRequestHeaders("0123456789ABCDEF0123456789ABCDEF");
    expect(headers["User-Agent"]).toBe(EDGE_CHROMIUM_UA);
    expect(headers.Origin).toBe(EDGE_ORIGIN);
    expect(headers.Pragma).toBe("no-cache");
    expect(headers["Cache-Control"]).toBe("no-cache");
    expect(headers["Accept-Encoding"]).toBe("gzip, deflate, br, zstd");
    expect(headers["Accept-Language"]).toBe("en-US,en;q=0.9");
    expect(headers.Cookie).toBe("muid=0123456789ABCDEF0123456789ABCDEF;");
    expect(headers.Cookie).not.toMatch(/^MUID=/);
  });

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

  it("maps Fish pause tags without emitting <break> elements Edge rejects as invalid SSML", () => {
    const ssml = buildEdgeSsml(
      `Hello ${FISH_SHORT_PAUSE} world\n${FISH_LONG_PAUSE}\nTom & Jerry`,
      ANDREW_NEURAL_VOICE_ID,
      { rate: "-15%" }
    );
    expect(ssml).toContain(`rate="-15%"`);
    expect(ssml).toContain("Hello");
    expect(ssml).toContain("world");
    expect(ssml).toContain("Tom &amp; Jerry");
    expect(ssml).not.toMatch(/\[(?:long-)?break\]/i);
    expect(ssml).not.toMatch(/<break\b/i);
    expect(ssml).not.toContain("&lt;break");
    const inner = ssml.match(/<prosody[^>]*>([\s\S]*)<\/prosody>/)?.[1] ?? "";
    expect(inner).toMatch(/Hello[\s\S]*world/);
    expect(inner).toMatch(/…|\n\n/);
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

  it("opens the socket with the current GEC version and muid cookie", async () => {
    let openedUrl = "";
    let openedHeaders: Record<string, string> = {};
    await synthesizeEdgeTts({
      text: "Hello from Standard.",
      voice: ANDREW_NEURAL_VOICE_ID,
      openSocket: (url, headers, handlers: EdgeSocketHandlers) => {
        openedUrl = url;
        openedHeaders = headers;
        queueMicrotask(() => {
          handlers.onOpen();
          handlers.onMessage(
            Buffer.concat([
              Buffer.from("Path:audio\r\n"),
              Buffer.from("ID3edge-audio"),
            ])
          );
          handlers.onMessage("Path:turn.end");
        });
        return { send: () => undefined, close: () => undefined };
      },
    });
    expect(openedUrl).toContain("Sec-MS-GEC-Version=1-143.0.3650.75");
    expect(openedUrl).not.toContain("3650.96");
    expect(openedHeaders.Cookie).toMatch(/^muid=[0-9A-F]{32};$/);
    expect(openedHeaders["Accept-Encoding"]).toBe("gzip, deflate, br, zstd");
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

  it.skipIf(!process.env.LIVE_EDGE_TTS)(
    "returns MP3 from the live Microsoft endpoint for Andrew",
    async () => {
      const started = Date.now();
      const audio = await synthesizeEdgeTts({
        text: "Hi, here is how I sound.",
        voice: ANDREW_NEURAL_VOICE_ID,
      });
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(audio.length).toBeGreaterThan(2_000);
      const mpeg =
        audio[0] === 0xff ||
        (audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33);
      expect(mpeg).toBe(true);
    },
    12_000
  );

  it("ends the turn when ws delivers Path:turn.end as a text Buffer", async () => {
    const audio = Buffer.from("ID3edge-audio");
    const result = await synthesizeEdgeTts({
      text: "Hello from Standard.",
      voice: ANDREW_NEURAL_VOICE_ID,
      openSocket: (_url, _headers, handlers) => {
        queueMicrotask(() => {
          handlers.onOpen();
          handlers.onMessage(
            Buffer.concat([Buffer.from("Path:audio\r\n"), audio])
          );
          handlers.onMessage(Buffer.from("X-RequestId:abc\r\nPath:turn.end\r\n\r\n{}"));
        });
        return { send: () => undefined, close: () => undefined };
      },
    });
    expect(result.equals(audio)).toBe(true);
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
