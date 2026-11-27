import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import esbuild from "esbuild";

const root = process.cwd();
const JOB = "live-book";
const audioDir = path.join(root, "e2e/.live-audio");

function ensureAudio() {
  mkdirSync(audioDir, { recursive: true });
  for (let i = 0; i < 8; i++) {
    const file = path.join(audioDir, `${String(i).padStart(4, "0")}.mp3`);
    if (existsSync(file)) continue;
    const made = spawnSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "15", "-c:a", "libmp3lame", "-b:a", "64k", file, "-loglevel", "error"],
      { stdio: "inherit" }
    );
    if (made.status !== 0) throw new Error("ffmpeg could not write the section");
  }
}

export async function startLiveGeneratingServer() {
  ensureAudio();
  const started = Date.now();
  const readyCount = () => Math.min(8, 6 + Math.floor((Date.now() - started) / 2000));
  const jobBody = () => {
    const n = readyCount();
    const segments = [];
    for (let i = 0; i < 8; i++) {
      segments.push({
        index: i,
        status: i < n ? "ready" : "pending",
        path: `audiobooks/${JOB}/sections/${String(i).padStart(4, "0")}.mp3`,
        durationSeconds: i < n ? 15 : null,
      });
    }
    return {
      id: JOB,
      book_title: "Holmes",
      voice_name: "Drew",
      status: "processing",
      progress: Math.min(99, 40 + Math.floor((Date.now() - started) / 2000)),
      current_section: n,
      total_sections: 8,
      audio_url: `/api/storage/audiobooks/${JOB}/full.mp3`,
      duration_seconds: n * 15,
      error_message: null,
      created_at: "2026-11-27T08:00:00.000Z",
      updated_at: "2026-11-27T08:45:00.000Z",
      job_kind: "takehome",
      tts_provider: "drew",
      segments,
      chapters: [],
      resume_position_seconds: null,
      resume_section_index: null,
      resume_updated_at: null,
      playback_grant: "grant",
      waiting_for_text: false,
    };
  };
  const playlist = () => {
    const n = readyCount();
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-PLAYLIST-TYPE:EVENT",
      "#EXT-X-TARGETDURATION:15",
      "#EXT-X-MEDIA-SEQUENCE:0",
      `#ECH-BYTES:${n * 1000}`,
    ];
    for (let i = 0; i < n; i++) {
      lines.push("#EXTINF:15.000,", `live/${String(i).padStart(4, "0")}.mp3`);
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

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: string | Buffer, type: string) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (url.pathname === "/") {
      send(
        200,
        `<!doctype html><html><body><div id="root"></div><script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
        "text/html"
      );
      return;
    }
    if (url.pathname === `/api/jobs/${JOB}` && req.method === "GET") {
      send(200, JSON.stringify({ job: jobBody() }), "application/json");
      return;
    }
    if (url.pathname.endsWith("/position")) {
      send(200, JSON.stringify({ positionSeconds: null, sectionIndex: null, updatedAt: null }), "application/json");
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
      send(200, readFileSync(path.join(audioDir, `${section[1]}.mp3`)), "audio/mpeg");
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
