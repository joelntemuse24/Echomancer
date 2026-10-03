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

const pages = new Map([
  ["/", clipHtml],
  ["/player", playerHtml],
]);

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  const html = pages.get(pathname) ?? clipHtml;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`component harnesses http://127.0.0.1:${port} and /player`);
});