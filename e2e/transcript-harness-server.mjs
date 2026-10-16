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
    .relative{position:relative}.flex{display:flex}.w-full{width:100%}.touch-none{touch-action:none}
    .items-center{align-items:center}.select-none{user-select:none}.min-h-11{min-height:2.75rem}
    .py-3{padding-top:.75rem;padding-bottom:.75rem}.grow{flex-grow:1}.overflow-hidden{overflow:hidden}
    .h-0\\.5{height:.125rem}.h-full{height:100%}.absolute{position:absolute}.block{display:block}
    .shrink-0{flex-shrink:0}.size-5{width:1.25rem;height:1.25rem}.bg-foreground{background:#222}
    .bg-foreground\\/20{background:rgba(0,0,0,.2)}
    body{margin:0}.max-w-2xl{max-width:42rem}.mx-auto{margin-left:auto;margin-right:auto}
  </style></head><body><div id="root"></div><script type="module">${req.url?.startsWith("/player") ? player : transcript}</script></body></html>`);
}).listen(4174, "127.0.0.1");
