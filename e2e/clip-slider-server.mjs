import { createServer } from "node:http";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.CLIP_SLIDER_PORT || 4173);

const built = await esbuild.build({
  absWorkingDir: root,
  entryPoints: [path.join(root, "e2e/clip-slider-harness.tsx")],
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

const js = built.outputFiles[0]?.text ?? "";
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clip range</title>
  <style>
    html, body { margin: 0; background: #0a0a0a; color: #f5f5f5; font-family: "Cormorant Garamond", Georgia, serif; }
    #spacer { height: 140vh; }
    #stage { padding: 24px 16px 48px; }
    p { text-align: center; font-size: 12px; letter-spacing: 0.01em; }
  </style>
</head>
<body>
  <div id="spacer"></div>
  <div id="stage"></div>
  <script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`clip slider harness http://127.0.0.1:${port}`);
});
