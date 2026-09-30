import type { NextConfig } from "next";

/**
 * File tracing follows `process.cwd()` and dynamic imports into every
 * function that can reach them. Drop the repo metadata and the libsql
 * builds Vercel cannot run. Document parsers stay on the extract route
 * only; every other route drops them. Trigger stays where take-home
 * dispatch can call it, and is omitted everywhere else.
 */
const UNUSED_AT_RUNTIME = [
  ".git/**",
  "data/**",
  "src/test/**",
  "**/*.md",
  "package-lock.json",
  "tsconfig.tsbuildinfo",
  "workers/**",
  "node_modules/epub2/**",
  "node_modules/@libsql/linux-x64-musl/**",
  "node_modules/@libsql/linux-arm64-gnu/**",
  "node_modules/@libsql/linux-arm64-musl/**",
  "node_modules/@libsql/darwin-x64/**",
  "node_modules/@libsql/darwin-arm64/**",
  "node_modules/@libsql/win32-x64-msvc/**",
];

const DOCUMENT_PARSERS = [
  "node_modules/unpdf/**",
  "node_modules/pdfjs-dist/**",
  "node_modules/mammoth/**",
  "node_modules/jszip/**",
  "node_modules/pako/**",
];

const TRIGGER_SDK = ["node_modules/@trigger.dev/**"];

/** Routes that never parse a PDF/DOCX/EPUB and never call Trigger. */
const SLIM_ROUTES = [
  "/api/auth/**",
  "/api/cron/**",
  "/api/health",
  "/api/me",
  "/api/storage/**",
  "/api/text/**",
  "/api/tts/preview",
  "/api/tts/voices",
  "/api/tts/live",
  "/api/tts/clones",
  "/api/tts/clones/[id]",
  "/api/tts/clones/upload/[id]/**",
  "/api/tts/youtube/search",
  "/api/jobs/[id]/cancel",
  "/api/jobs/[id]/process",
  "/api/jobs/[id]/stream",
  "/api/jobs/[id]/markup",
  "/api/jobs/[id]/transcript",
  "/api/pdf/upload/[id]/narrator",
  "/api/pdf/upload/[id]/object",
  "/dashboard/**",
  "/sign-in/**",
  "/privacy",
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.ytimg.com", pathname: "/vi/**" },
    ],
  },
  serverExternalPackages: [
    "epub2",
    "mammoth",
    "unpdf",
    "jszip",
    "pdfjs-dist",
    "@trigger.dev/sdk",
  ],
  outputFileTracingExcludes: {
    "*": UNUSED_AT_RUNTIME,
    "/api/jobs": DOCUMENT_PARSERS.filter(
      (pattern) => !pattern.includes("jszip") && !pattern.includes("pako")
    ),
    "/api/jobs/[id]/download": TRIGGER_SDK,
    "/api/tts/clones/upload": DOCUMENT_PARSERS,
    ...Object.fromEntries(SLIM_ROUTES.map((route) => [route, [...DOCUMENT_PARSERS, ...TRIGGER_SDK]])),
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
