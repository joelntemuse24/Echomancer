import { describe, expect, it } from "vitest";
import { htmlToArticle } from "@/lib/html-article";

const PROSE =
  "The lamps were lit along the quay before the tide turned, and she closed the ledger.";

describe("htmlToArticle", () => {
  it("keeps the article and drops chrome, scripts, and the title tag", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Site chrome</title>
  <meta property="og:title" content="The Quay at Dusk">
  <script>const secret = "supercalifragilistic"; if (a < b) alert(1);</script>
  <style>.x { content: "not spoken"; }</style>
</head>
<body>
  <nav><a href="/home">Home navigation that should stay unspoken</a></nav>
  <article>
    <h1>The Quay at Dusk</h1>
    <p>${PROSE}</p>
    <p>Tom &amp; Jerry&#8217;s boat waited.</p>
  </article>
  <footer>Copyright example news footer text</footer>
</body>
</html>`;

    const article = htmlToArticle(html);
    expect(article.title).toBe("The Quay at Dusk");
    expect(article.text).toContain(PROSE);
    expect(article.text).toContain("Tom & Jerry’s boat waited.");
    expect(article.text).not.toContain("supercalifragilistic");
    expect(article.text).not.toContain("not spoken");
    expect(article.text).not.toContain("Home navigation");
    expect(article.text).not.toContain("Copyright example");
    expect(article.text).not.toContain("Site chrome");
  });

  it("reads the body when the page has no article", () => {
    const html = `<html><head><title>Notes</title></head><body><p>${PROSE}</p></body></html>`;
    const article = htmlToArticle(html);
    expect(article.title).toBe("Notes");
    expect(article.text).toContain(PROSE);
  });

  it("prefers the longer article", () => {
    const html = `<body>
      <article><p>Short.</p></article>
      <article><p>${PROSE}</p></article>
    </body>`;
    expect(htmlToArticle(html).text).toContain("lamps were lit");
    expect(htmlToArticle(html).text).not.toContain("Short.");
  });

  it("keeps the article when the document shell mentions a menu", () => {
    const html = `<html class="vector-feature-language-in-main-menu-disabled"><body>
      <div class="mw-portlet"><span>63 languages</span></div>
      <p>${PROSE}</p>
    </body></html>`;
    const article = htmlToArticle(html);
    expect(article.text).toContain(PROSE);
    expect(article.text).not.toContain("63 languages");
  });

  it("drops language menus and navigation roles", () => {
    const html = `<body>
      <div class="mw-portlet vector-dropdown" id="p-lang-btn">
        <span>63 languages</span>
        <a href="/wiki/de">Deutsch</a>
      </div>
      <div role="navigation">Jump to content</div>
      <article><h1>Audiobook</h1><p>${PROSE}</p></article>
    </body>`;
    const article = htmlToArticle(html);
    expect(article.text).toContain(PROSE);
    expect(article.text).not.toContain("63 languages");
    expect(article.text).not.toContain("Deutsch");
    expect(article.text).not.toContain("Jump to content");
  });

  it("reads a main region", () => {
    const html = `<html><body><main><h1>Ledger</h1><p>${PROSE}</p></main><p>Sidebar blurb.</p></body></html>`;
    const article = htmlToArticle(html);
    expect(article.title).toBe("Ledger");
    expect(article.text).toContain(PROSE);
  });
});
