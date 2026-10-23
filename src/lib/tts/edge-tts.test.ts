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
  EDGE_OUTPUT_FORMAT,
  EDGE_OUTPUT_FORMAT_COMPAT,
  edgeRateFromSpeed,
  edgeRequestHeaders,
  edgeWebsocketUrl,
  escapeEdgeSsmlText,
  edgeStreamBudgetMs,
  extractEdgeAudioPayload,
  generateSecMsGec,
  isEdgeTurnEnd,
  synthesizeEdgeTts,
  splitEdgeText,
  edgeChunkBudgetMs,
  type EdgeSocketHandlers,
} from "./edge-tts";

describe("Edge TTS protocol helpers", () => {
  it("pins Sec-MS-GEC-Version to the working Chromium full build", () => {
    expect(EDGE_CHROMIUM_FULL_VERSION).toBe("143.0.3650.75");
    expect(EDGE_SEC_MS_GEC_VERSION).toBe("2-143.0.3650.75");
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
    expect(url).toContain("Sec-MS-GEC-Version=2-143.0.3650.75");

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
    expect(a).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/);

    const skewed = generateSecMsGec({
      nowMs: 1_700_000_000_000,
      clockSkewSeconds: 600,
    });
    expect(skewed).not.toBe(a);
  });

  it("matches the edge-tts 7.3.1 v2 Sec-MS-GEC vectors", () => {
    // Vectors from python edge-tts 7.3.1 drm.generate_sec_ms_gec_v2.
    const vectors: Array<[number, string]> = [
      [
        1_761_170_000,
        "67E3AEC602F5E1F4-475875386968E260A057334E8533455267A324A6228C4704FA0E779C5CF0A0C8",
      ],
      [
        1_800_000_000,
        "99E54519B490BE5C-E162DB0977FBDCB9B86DD8148BF1BCDC3C0303176CE39852A42B415935C20654",
      ],
      [
        1_700_000_123.5,
        "0919602B5750900A-EC9DD394F23CB5635CF62A0E8E24136DCD32B26D10C543B10082E482D7516397",
      ],
    ];
    for (const [unix, expected] of vectors) {
      expect(
        generateSecMsGec({ nowMs: unix * 1000, clockSkewSeconds: 0 })
      ).toBe(expected);
    }
  });

  it("keeps the v2 token stable inside a five-minute window and shifts across it", () => {
    const base = generateSecMsGec({ nowMs: 1_761_170_000_000 });
    // 1761170000s floors to the window starting 1761169800s; the next starts
    // at 1761170100s.
    expect(generateSecMsGec({ nowMs: 1_761_170_050_000 })).toBe(base);
    expect(generateSecMsGec({ nowMs: 1_761_170_100_000 })).not.toBe(base);
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

  it("strips leftover Fish emotion tags and never emits <break>", () => {
    const ssml = buildEdgeSsml(
      `[calm] Hello ${FISH_SHORT_PAUSE} world [whispering]`,
      ANDREW_NEURAL_VOICE_ID
    );
    expect(ssml).toContain("Hello");
    expect(ssml).toContain("world");
    expect(ssml).not.toMatch(/\[[^\]]+\]/);
    expect(ssml).not.toMatch(/whispering|calm/i);
    expect(ssml).not.toMatch(/<break\b/i);
    expect(ssml).not.toContain("&lt;break");
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
    expect(openedUrl).toContain("Sec-MS-GEC-Version=2-143.0.3650.75");
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
    expect(sent.join("\n")).toContain(EDGE_OUTPUT_FORMAT);
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

  it("falls back to 48 kbps when the higher format returns no audio", async () => {
    const formats: string[] = [];
    const audio = Buffer.from("ID3edge-audio");
    let calls = 0;
    const result = await synthesizeEdgeTts({
      text: "Hello from Standard.",
      openSocket: (_url, _headers, handlers) => {
        calls += 1;
        const attempt = calls;
        queueMicrotask(() => {
          handlers.onOpen();
          if (attempt === 1) {
            handlers.onMessage("Path:turn.end");
            return;
          }
          handlers.onMessage(
            Buffer.concat([Buffer.from("Path:audio\r\n"), audio])
          );
          handlers.onMessage("Path:turn.end");
        });
        return {
          send: (data) => {
            if (data.includes("outputFormat")) formats.push(data);
          },
          close: () => undefined,
        };
      },
    });
    expect(result.equals(audio)).toBe(true);
    expect(calls).toBe(2);
    expect(formats[0]).toContain(EDGE_OUTPUT_FORMAT);
    expect(formats[1]).toContain(EDGE_OUTPUT_FORMAT_COMPAT);
  });

  it("stalls when audio arrives and the socket then goes silent", async () => {
    let closed = false;
    let opens = 0;
    const audio = Buffer.from("ID3partial-audio");
    await expect(
      synthesizeEdgeTts({
        text: "Hello from Standard.",
        inactivityMs: 40,
        totalCapMs: 5_000,
        openSocket: (_url, _headers, handlers) => {
          opens += 1;
          queueMicrotask(() => {
            handlers.onOpen();
            handlers.onMessage(
              Buffer.concat([Buffer.from("Path:audio\r\n"), audio])
            );
          });
          return {
            send: () => undefined,
            close: () => {
              closed = true;
            },
          };
        },
      })
    ).rejects.toThrow("Edge TTS stalled");
    expect(opens).toBe(1);
    expect(closed).toBe(true);
    expect(edgeStreamBudgetMs(10)).toBe(45_000);
    expect(edgeStreamBudgetMs(450)).toBe(120_000);
    expect(edgeStreamBudgetMs(4_000)).toBeGreaterThanOrEqual(240_000);
    expect(edgeStreamBudgetMs(4_000)).toBeLessThanOrEqual(300_000);
    expect(edgeStreamBudgetMs(10_000)).toBe(300_000);
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

describe("Edge section chunking", () => {
  it("splits long section text on sentence boundaries without losing words", () => {
    const text = "Sentence one is here. ".repeat(120);
    const chunks = splitEdgeText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length).toBeGreaterThanOrEqual(1_000);
      expect(chunk.length).toBeLessThanOrEqual(1_500);
    }
    expect(chunks.join("")).toBe(text.trim());
    expect(chunks[0]!.trimEnd().endsWith(".")).toBe(true);
  });

  it("prefers paragraph boundaries, then hard-splits unbroken runs", () => {
    const paragraph = "A paragraph line. ".repeat(60) + "\n\n";
    const chunks = splitEdgeText(paragraph.repeat(4));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(paragraph.repeat(4).trim());

    const run = "A".repeat(4_000);
    expect(splitEdgeText(run)).toEqual(["A".repeat(1_500), "A".repeat(1_500), "A".repeat(1_000)]);
  });

  it("keeps short text as one chunk and budgets the chunk clock", () => {
    expect(splitEdgeText("Hello from Standard.")).toEqual(["Hello from Standard."]);
    expect(splitEdgeText("")).toEqual([]);
    expect(edgeChunkBudgetMs(300)).toBe(30_000);
    expect(edgeChunkBudgetMs(1_200)).toBeLessThanOrEqual(90_000);
    expect(edgeChunkBudgetMs(9_000)).toBe(90_000);
  });

  it("synthesizes a long section as parallel chunk turns and strips inner ID3 tags", async () => {
    const text = "A".repeat(2_000); // hard split at 1,500 → two chunks
    const tag = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 0]);
    const turnAudio = (n: number) =>
      Buffer.concat([tag, Buffer.from(`TURN${n}AUDIO`)]);

    const ssmlLengths: number[] = [];
    const audio = await synthesizeEdgeTts({
      text,
      voice: ANDREW_NEURAL_VOICE_ID,
      openSocket: (_url, _headers, handlers: EdgeSocketHandlers) => {
        const turn = ssmlLengths.length;
        ssmlLengths.push(0);
        queueMicrotask(() => {
          handlers.onOpen();
          handlers.onMessage(Buffer.concat([Buffer.from("Path:audio\r\n"), turnAudio(turn)]));
          handlers.onMessage("Path:turn.end");
        });
        return { send: () => undefined, close: () => undefined };
      },
    });

    // Two chunks synthesized; each SSML turn is one chunk-sized body.
    expect(ssmlLengths.length).toBe(2);
    expect(audio.equals(
      Buffer.concat([turnAudio(0), Buffer.from("TURN1AUDIO")])
    )).toBe(true);
  });

  it("retries a failed chunk without re-speaking the whole section", async () => {
    const text = "A".repeat(2_000);
    const tag = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0, 0, 0, 0]);
    let opens = 0;
    let chunk0ErrorFired = false;
    const audio = await synthesizeEdgeTts({
      text,
      voice: ANDREW_NEURAL_VOICE_ID,
      openSocket: (_url, _headers, handlers: EdgeSocketHandlers) => {
        const turn = opens + 1;
        opens += 1;
        queueMicrotask(() => {
          handlers.onOpen();
          if (turn === 1) {
            // Chunk 0 dies mid-turn; chunk 1 (opened later in parallel) succeeds.
            chunk0ErrorFired = true;
            handlers.onError(new Error("Edge TTS socket closed (1006): boom"));
            return;
          }
          handlers.onMessage(Buffer.concat([Buffer.from("Path:audio\r\n"), tag, Buffer.from("AUDIO")]));
          handlers.onMessage("Path:turn.end");
        });
        return { send: () => undefined, close: () => undefined };
      },
    });

    // Attempt 1 failed chunk 0 (and chunk 1's turn already succeeded), attempt
    // 2 re-spoke only chunk 0: one extra turn, not two full sections.
    expect(chunk0ErrorFired).toBe(true);
    expect(opens).toBe(3);
    expect(audio.equals(
      Buffer.concat([tag, Buffer.from("AUDIO"), Buffer.from("AUDIO")])
    )).toBe(true);
  });
});
