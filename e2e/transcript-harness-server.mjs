import { createServer } from "node:http";
import esbuild from "esbuild";

async function bundle(entryPoints, navigation = false) {
  const built = await esbuild.build({
    entryPoints: [entryPoints], bundle: true, write: false,
    format: "esm", platform: "browser", jsx: "automatic",
    tsconfig: "tsconfig.json",
    plugins: navigation ? [{
      name: "next-navigation",
      setup(build) {
        build.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({ path: args.path, namespace: "next-stub" }));
        build.onLoad({ filter: /.*/, namespace: "next-stub" }, (args) => ({
          contents: args.path === "next/navigation"
            ? 'export const useRouter = () => ({ push() {} }); export const useSearchParams = () => new URLSearchParams(location.search);'
            : 'import React from "react"; export default function Link({href,children,...props}) {return React.createElement("a",{href,...props},children)}',
          loader: "js", resolveDir: process.cwd(),
        }));
      },
    }] : [],
  });
  return built.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
}
const transcript = await bundle("e2e/transcript-harness.tsx");
const player = await bundle("e2e/player-audit-harness.tsx", true);
createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><style>
    [role=region]{height:400px;overflow-y:auto} [data-block]{min-height:64px}
    button:focus-visible{outline:2px solid blue}
  </style></head><body><div id="root"></div><script type="module">${req.url?.startsWith("/player") ? player : transcript}</script></body></html>`);
}).listen(4174, "127.0.0.1");
