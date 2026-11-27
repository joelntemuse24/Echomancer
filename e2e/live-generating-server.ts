import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import esbuild from "esbuild";

const root = process.cwd();
const JOB = "live-book";
export const LIVE_SECTION_SECONDS = 15;
const audioDir = path.join(root, "e2e/.live-audio");

function ensureAudio(total: number) {
  mkdirSync(audioDir, { recursive: true });
  for (let i = 0; i < total; i++) {
    const file = path.join(audioDir, `${String(i).padStart(4, "0")}.mp3`);
    if (existsSync(file)) continue;
    const made = spawnSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", String(LIVE_SECTION_SECONDS), "-c:a", "libmp3lame", "-b:a", "64k", file, "-loglevel", "error"],
      { stdio: "inherit" }
    );
    if (made.status !== 0) throw new Error("ffmpeg could not write the section");
  }
}

export async function startLiveGeneratingServer(options?: {
  initialReady?: number;
  total?: number;
  /** How often another section becomes ready. 0 keeps the initial count. */
  growMs?: number;
  /** One index stays pending so a later ready part sits past a hole. */
  gapIndex?: number;
}) {
  const total = options?.total ?? 12;
  const initialReady = options?.initialReady ?? 8;
  const growMs = options?.growMs ?? 2000;
  const gapIndex = options?.gapIndex;
  ensureAudio(total);
  const started = Date.now();
  const readyCount = () =>
    growMs > 0 ? Math.min(total, initialReady + Math.floor((Date.now() - started) / growMs)) : Math.min(total, initialReady);
  let position: { positionSeconds: number; sectionIndex: number | null; updatedAt: number } | null =
    null;
  const jobBody = () => {
    const n = readyCount();
    const segments = [];
    for (let i = 0; i < total; i++) {
      const gapped = gapIndex === i;
      const ready = !gapped && i < n;
      segments.push({
        index: i,
        status: ready ? "ready" : "pending",
        path: `audiobooks/${JOB}/sections/${String(i).padStart(4, "0")}.mp3`,
        durationSeconds: ready ? LIVE_SECTION_SECONDS : null,
      });
    }
    return {
      id: JOB,
      book_title: "Holmes",
      voice_name: "Drew",
      status: "processing",
      progress: Math.min(99, 40 + Math.floor((Date.now() - started) / 2000)),
      current_section: n,
      total_sections: total,
      eta_label: `mark ${Math.floor((Date.now() - started) / 2000)}`,
      eta_state: "scheduled",
      audio_url: `/api/storage/audiobooks/${JOB}/full.mp3`,
      duration_seconds: (gapIndex == null ? n : Math.min(n, gapIndex)) * LIVE_SECTION_SECONDS,
      error_message: null,
      created_at: "2026-11-27T08:00:00.000Z",
      updated_at: "2026-11-27T08:45:00.000Z",
      job_kind: "takehome",
      tts_provider: "drew",
      segments,
      chapters: [],
      resume_position_seconds: position?.positionSeconds ?? null,
      resume_section_index: position?.sectionIndex ?? null,
      resume_updated_at: position?.updatedAt ?? null,
      playback_grant: "grant",
      waiting_for_text: false,
    };
  };
  const playlist = () => {
    const published = readyCount();
    const n = gapIndex == null ? published : Math.min(published, gapIndex);
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-PLAYLIST-TYPE:EVENT",
      `#EXT-X-TARGETDURATION:${LIVE_SECTION_SECONDS}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      `#ECH-BYTES:${n * 1000}`,
    ];
    for (let i = 0; i < n; i++) {
      lines.push(`#EXTINF:${LIVE_SECTION_SECONDS}.000,`, `live/${String(i).padStart(4, "0")}.mp3`);
    }
    return `${lines.join("\n")}\n`;
  };

  const built = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "e2e/player-audit-harness.tsx")],
    bundle: true,
    format: "esm",
    write: false,
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "next-stub",
        setup(build) {
          build.onResolve({ filter: /^next\/(navigation|link|image)$/ }, (args) => ({
            path: args.path,
            namespace: "next-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "next-stub" }, (args) => ({
            contents:
              args.path === "next/navigation"
                ? `export const useRouter = () => ({ push() {}, replace() {}, prefetch() {}, back() {} });
                   export const usePathname = () => "/dashboard/player/${JOB}";
                   export const useSearchParams = () => new URLSearchParams();`
                : `import React from "react";
                   export default function Link({href,children,...props}) {
                     return React.createElement("a", {href, ...props}, children);
                   }`,
            loader: "js",
            resolveDir: root,
          }));
        },
      },
    ],
  });
  const file = built.outputFiles[0];
  if (!file) throw new Error("player bundle was empty");
  const js = file.text;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: string | Buffer, type: string) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (url.pathname === "/") {
      send(
        200,
        `<!doctype html><html><head><style>
          html, body { margin: 0; background: #111; }
          #root { width: min(720px, 100vw); margin: 0 auto; }
          [data-slot="slider"] { display: flex; align-items: center; position: relative; width: 100%; min-height: 44px; touch-action: none; }
          [data-slot="slider-track"] { position: relative; flex: 1 1 auto; height: 4px; }
        </style></head><body><div id="root"></div><script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
        "text/html"
      );
      return;
    }
    if (url.pathname === `/api/jobs/${JOB}` && req.method === "GET") {
      send(200, JSON.stringify({ job: jobBody() }), "application/json");
      return;
    }
    if (url.pathname === `/api/jobs/${JOB}/position`) {
      if (req.method === "PUT") {
        const raw = await new Promise<string>((resolve) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(chunk as Buffer));
          req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        const body = JSON.parse(raw) as { positionSeconds?: number; sectionIndex?: number | null };
        position = {
          positionSeconds: typeof body.positionSeconds === "number" ? body.positionSeconds : 0,
          sectionIndex: typeof body.sectionIndex === "number" ? body.sectionIndex : null,
          updatedAt: Date.now(),
        };
        send(200, JSON.stringify(position), "application/json");
        return;
      }
      send(
        200,
        JSON.stringify(position ?? { positionSeconds: null, sectionIndex: null, updatedAt: null }),
        "application/json"
      );
      return;
    }
    if (url.pathname.includes("/bookmarks")) {
      send(200, JSON.stringify({ bookmarks: [] }), "application/json");
      return;
    }
    if (url.pathname.endsWith("/live.m3u8")) {
      send(200, playlist(), "application/vnd.apple.mpegurl");
      return;
    }
    const section = url.pathname.match(/\/(?:sections|live)\/(\d{4})\.mp3$/);
    if (section) {
      const file = readFileSync(path.join(audioDir, `${section[1]}.mp3`));
      const range = req.headers.range;
      const match = typeof range === "string" ? /bytes=(\d+)-(\d+)?/.exec(range) : null;
      if (match) {
        const start = Number(match[1] ?? 0);
        const requested = match[2] ? Number(match[2]) : file.length - 1;
        const end = Math.min(file.length - 1, Number.isFinite(requested) ? requested : file.length - 1);
        if (!Number.isFinite(start) || start < 0 || start >= file.length || end < start) {
          res.writeHead(416, { "content-range": `bytes */${file.length}` });
          res.end();
          return;
        }
        const slice = file.subarray(start, end + 1);
        res.writeHead(206, {
          "content-type": "audio/mpeg",
          "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${end}/${file.length}`,
          "content-length": String(slice.length),
          "cache-control": "no-store",
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "accept-ranges": "bytes",
        "content-length": String(file.length),
        "cache-control": "no-store",
      });
      res.end(file);
      return;
    }
    send(404, "no", "text/plain");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
