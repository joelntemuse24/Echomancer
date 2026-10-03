import { createServer } from "node:http";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HARNESS_PORT || 4173);

async function bundle(entry) {
  const built = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: "esm",
    write: false,
    platform: "browser",
    jsx: "automatic",
    // Next.js inlines NEXT_PUBLIC_* into client bundles; this raw bundle
    // needs the same so the shared format modules never touch `process`.
    define: {
      "process.env.MAX_UPLOAD_MB": "undefined",
      "process.env.NEXT_PUBLIC_MAX_UPLOAD_MB": '"512"',
      "process.env.MAX_CLONE_SAMPLE_MB": "undefined",
      "process.env.NEXT_PUBLIC_MAX_CLONE_SAMPLE_MB": '"32"',
    },
    plugins: [
      {
        name: "at-alias",
        setup(build) {
          build.onResolve({ filter: /^@\// }, (args) => {
            const base = path.join(root, "src", args.path.slice(2));
            for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
              const file = base + suffix;
              if (existsSync(file) && statSync(file).isFile()) return { path: file };
            }
            return { errors: [{ text: `Cannot resolve ${args.path}` }] };
          });
        },
      },
    ],
  });
  return built.outputFiles[0]?.text ?? "";
}

const clipJs = await bundle("e2e/clip-slider-harness.tsx");
const playerJs = await bundle("e2e/player-seek-harness.tsx");
const uploadJs = await bundle("e2e/book-upload-harness.tsx");
const voiceFlowJs = await bundle("e2e/voice-flow-harness.tsx");

function page(title, body, style, js) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    html, body { margin: 0; background: #0a0a0a; color: #f5f5f5; font-family: "Cormorant Garamond", Georgia, serif; }
    button { font: inherit; font-size: 12px; letter-spacing: 0.01em; color: #f5f5f5; background: none; border: 1px solid #444; border-radius: 6px; padding: 8px 12px; margin: 0 4px 8px 0; }
    p { text-align: center; font-size: 12px; letter-spacing: 0.01em; }
    ${style}
  </style>
</head>
<body>
  ${body}
  <script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>`;
}

// The clip harness keeps its own inline-styled component; the player harness
// renders the real Slider wrapper, so these rules mirror the Tailwind output
// for the utility classes it uses (spacing, 44px rows, track, thumb).
const playerStyle = `
  .relative{position:relative}
  .flex{display:flex}
  .w-full{width:100%}
  .touch-none{touch-action:none}
  .items-center{align-items:center}
  .select-none{user-select:none}
  .min-h-11{min-height:2.75rem}
  .py-3{padding-top:0.75rem;padding-bottom:0.75rem}
  .cursor-pointer{cursor:pointer}
  .opacity-40{opacity:0.4}
  .grow{flex-grow:1}
  .overflow-hidden{overflow:hidden}
  .rounded-full{border-radius:9999px}
  .h-0\\.5{height:0.125rem}
  .h-full{height:100%}
  .absolute{position:absolute}
  .block{display:block}
  .shrink-0{flex-shrink:0}
  .size-5{width:1.25rem;height:1.25rem}
  .border-2{border-width:2px}
  .border-foreground{border-color:#f5f5f5}
  .bg-foreground{background:#f5f5f5}
  .bg-foreground\\/20{background:rgba(245,245,245,0.2)}
  .space-y-2 > * + *{margin-top:0.5rem}
  .space-y-1 > * + *{margin-top:0.25rem}
  .pt-1{padding-top:0.25rem}
  .justify-between{justify-content:space-between}
  .text-xs{font-size:0.75rem}
  .text-\\[11px\\]{font-size:11px}
  .text-center{text-align:center}
  .text-muted-foreground{color:#a3a3a3}
  .font-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
`;

const clipHtml = page(
  "Clip range",
  `<div id="spacer" style="height: 140vh;"></div>
  <div id="stage" style="padding: 24px 16px 48px;"></div>`,
  "",
  clipJs
);

const playerHtml = page(
  "Player seek",
  `<div id="stage"></div>`,
  playerStyle,
  playerJs
);

const uploadHtml = page(
  "Book upload",
  `<div id="spacer" style="height: 140vh;"></div>
  <div id="stage" style="padding: 24px 16px 48px;"></div>`,
  "",
  uploadJs
);

const voiceFlowHtml = page(
  "Voice flow",
  `<div id="stage" style="padding: 24px 16px 48px; max-width: 640px; margin: 0 auto;"></div>`,
  "",
  voiceFlowJs
);

const pages = new Map([
  ["/", clipHtml],
  ["/player", playerHtml],
  ["/book-upload", uploadHtml],
  ["/voice-flow", voiceFlowHtml],
]);

// Mock upload API for the book-upload harness.
// Mirrors the real route contract: presign (JSON) -> PUT bytes -> complete.
const requests = [];
const sinks = new Map();
const clientLogs = [];

// Voice-flow mocks, keyed by upload id so parallel spec files cannot disturb
// each other's scenario. Defaults mirror the owner report: extraction is
// in flight and never finishes, and the narrator suggestion is slow.
const defaultVoiceFlowConfig = () => ({
  mode: "extracting", // "extracting" | "ready-after"
  readyAfter: 2, // polls before ready when mode = "ready-after"
  deadPolls: 0, // first K status polls die at the network level
  jobHang: false, // POST /api/jobs never answers
  narratorHang: true, // narrator suggestion never answers
});
const voiceFlowConfigs = new Map();
const voiceFlowPolls = new Map();
const JOB_ID = "eeeeeeee-0000-4000-8000-00000000000e";

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

const UPLOAD_ID_RE =
  /^\/api\/pdf\/upload\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/pdf/upload") {
    const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
    requests.push({ method: "POST", url: "/api/pdf/upload", body });
    const uploadId = "33333333-3333-4333-8333-333333333333";
    return json(res, 200, {
      uploadId,
      putUrl: `/sink/${uploadId}`,
      putMethod: "PUT",
      putHeaders: { "Content-Type": body.contentType || "application/octet-stream" },
      storagePath: `pdfs/${uploadId}/content.txt`,
    });
  }
  const complete = UPLOAD_ID_RE.exec(url.pathname);
  if (req.method === "POST" && complete) {
    const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
    requests.push({ method: "POST", url: "/api/pdf/upload/:id", body });
    return json(res, 200, {
      uploadId: complete[1],
      status: "extracting",
      storagePath: `pdfs/${complete[1]}/content.txt`,
      fileName: body.fileName || "book",
      charCount: 0,
      fileSize: sinks.get(complete[1])?.byteLength || 0,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/log") {
    const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
    clientLogs.push(body);
    res.writeHead(204, { "cache-control": "no-store" });
    return res.end();
  }
  // Voice-flow mocks (keyed by upload id; see defaultVoiceFlowConfig).
  const voiceUpload = UPLOAD_ID_RE.exec(url.pathname);
  if (req.method === "POST" && url.pathname === "/api/mock-config") {
    const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
    if (body.uploadId) {
      voiceFlowConfigs.set(body.uploadId, {
        ...defaultVoiceFlowConfig(),
        ...(voiceFlowConfigs.get(body.uploadId) || {}),
        ...body.config,
      });
      voiceFlowPolls.set(body.uploadId, 0);
    }
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && voiceUpload) {
    const uploadId = voiceUpload[1];
    const config = {
      ...defaultVoiceFlowConfig(),
      ...(voiceFlowConfigs.get(uploadId) || {}),
    };
    const nth = voiceFlowPolls.get(uploadId) || 0;
    voiceFlowPolls.set(uploadId, nth + 1);
    requests.push({
      method: "GET",
      url: "/api/pdf/upload/:id",
      uploadId,
      nth,
    });
    // A dead poll: the phone slept or lost signal. The socket dies before
    // any status is written, exactly like a dropped mobile connection.
    if (nth < config.deadPolls) {
      res.destroy();
      return;
    }
    if (config.mode === "ready-after" && nth >= config.readyAfter) {
      return json(res, 200, {
        uploadId,
        status: "ready",
        charCount: 4321,
        storagePath: `pdfs/${uploadId}/content.txt`,
        chapters: [],
      });
    }
    return json(res, 200, {
      uploadId,
      status: "extracting",
      charCount: 0,
      storagePath: `pdfs/${uploadId}/content.txt`,
    });
  }
  if (req.method === "GET" && url.pathname.endsWith("/narrator")) {
    const uploadId = url.pathname.split("/")[4] || "unknown";
    const config = {
      ...defaultVoiceFlowConfig(),
      ...(voiceFlowConfigs.get(uploadId) || {}),
    };
    requests.push({
      method: "GET",
      url: "/api/pdf/upload/:id/narrator",
      uploadId,
    });
    if (config.narratorHang) return; // slow listen-prep: no answer yet
    return json(res, 200, { recommendation: "Andrew (recommended)" });
  }
  if (req.method === "POST" && url.pathname === "/api/jobs") {
    const body = JSON.parse((await readBody(req)).toString("utf-8") || "{}");
    const uploadId = String(body.pdfStoragePath || "").split("/")[1] || "";
    requests.push({ method: "POST", url: "/api/jobs", uploadId, body });
    if (voiceFlowConfigs.get(uploadId)?.jobHang) {
      return; // the enqueue POST never answers
    }
    return json(res, 200, {
      jobId: JOB_ID,
      status: "queued",
      duplicate: false,
      message: "Take-home job queued — generation starts shortly",
    });
  }
  if (req.method === "GET" && url.pathname === "/api/requests") {
    return json(res, 200, { requests, clientLogs });
  }
  if (req.method === "DELETE" && url.pathname === "/api/requests") {
    requests.length = 0;
    clientLogs.length = 0;
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "not found" });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const pathname = url.pathname;
  if (pathname.startsWith("/api/")) {
    try {
      return await handleApi(req, res, url);
    } catch (err) {
      return json(res, 500, { error: String(err) });
    }
  }
  if (pathname.startsWith("/sink/")) {
    const id = pathname.split("/")[2] || "unknown";
    const bytes = await readBody(req);
    if (req.method === "PUT") {
      sinks.set(id, bytes);
      requests.push({ method: "PUT", url: `/sink/${id}`, bytes: bytes.byteLength });
      return json(res, 200, { ok: true, bytes: bytes.byteLength });
    }
    return json(res, 405, { error: "method" });
  }
  const html = pages.get(pathname) ?? clipHtml;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`component harnesses http://127.0.0.1:${port}, /player and /book-upload`);
});