import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/**
 * Next 16.1.6 fails `next build` when Google answers with an extensionless
 * `/l/font?kit=` URL. The `&` inside that URL splits Turbopack's font query,
 * which is the Vercel error "next/font/google queries have exactly one entry".
 * 16.4.3 encodes the query and reads the CSS format hint. The families in
 * the layout stay on next/font/google.
 */
describe("google font build", () => {
  it("parses the extensionless Inter URL that failed the Vercel build", () => {
    const { findFontFilesInCss } = require(
      "next/dist/compiled/@next/font/dist/google/find-font-files-in-css.js"
    ) as {
      findFontFilesInCss: (
        css: string,
        subsets: string[] | undefined
      ) => { googleFontFileUrl: string; ext: string }[];
    };
    const css = `
/* latin-ext */
@font-face {
  font-display: swap;
  src: url(https://fonts.gstatic.com/l/font?kit=UcCB3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuOKfU5NJeWUdIOjBeTGiXZdCD2MVsiEu&skey=c491285d6722e4fa&v=v20) format('woff2');
  unicode-range: U+0102-0103;
}
`;
    const files = findFontFilesInCss(css, ["latin"]);
    expect(files).toHaveLength(1);
    expect(files[0]?.ext).toBe("woff2");
    expect(files[0]?.googleFontFileUrl).toContain("&skey=c491285d6722e4fa");
  });

  it("keeps Next on the release that encodes those URLs, and the same families", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      dependencies: { next: string };
    };
    const [major, minor, patch] = pkg.dependencies.next.split(".").map(Number);
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(
      16_004_003
    );
    const layout = readFileSync(path.join(root, "src/app/layout.tsx"), "utf8");
    expect(layout).toContain('from "next/font/google"');
    expect(layout).toContain("Cormorant_Garamond");
    expect(layout).toContain("Inter");
    expect(layout).not.toContain("next/font/local");
  });
});
