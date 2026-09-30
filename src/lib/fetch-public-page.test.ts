import http from "node:http";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PageDeps,
  type PageResponse,
  readPublicUrl,
  requestPublic,
  setPageDepsForTests,
} from "@/lib/fetch-public-page";
import { PublicUrlError } from "@/lib/public-url";

const PROSE =
  "The lamps were lit along the quay before the tide turned, and she closed the ledger.";

const ARTICLE = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Quay notes">
</head><body><article><h1>Quay notes</h1><p>${PROSE}</p></article></body></html>`;

function htmlResponse(body: string, status = 200): PageResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: Buffer.from(body),
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a tcp port");
      }
      resolve(address.port);
    });
  });
}

afterEach(() => {
  setPageDepsForTests(null);
});

describe("readPublicUrl", () => {
  it("reads an article and follows a redirect to another public host", async () => {
    const hosts: string[] = [];
    const deps: PageDeps = {
      lookup: async (hostname) => {
        hosts.push(hostname);
        return [
          {
            address: hostname === "cdn.example" ? "1.0.0.1" : "1.1.1.1",
            family: 4,
          },
        ];
      },
      request: async (input) => {
        if (input.url.hostname === "news.example") {
          return {
            status: 302,
            headers: { location: "https://cdn.example/story" },
            body: Buffer.alloc(0),
          };
        }
        expect(input.ip).toBe("1.0.0.1");
        expect(input.url.pathname).toBe("/story");
        return htmlResponse(ARTICLE);
      },
    };

    const page = await readPublicUrl("https://news.example/start", deps);
    expect(page.title).toBe("Quay notes");
    expect(page.text).toContain("lamps were lit");
    expect(hosts).toEqual(["news.example", "cdn.example"]);
  });

  it("does not request a redirect onto a private address", async () => {
    const requested: string[] = [];
    const deps: PageDeps = {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      request: async (input) => {
        requested.push(input.url.hostname);
        return {
          status: 302,
          headers: { location: "http://127.0.0.1/secret" },
          body: Buffer.alloc(0),
        };
      },
    };

    await expect(readPublicUrl("https://news.example/go", deps)).rejects.toMatchObject({
      code: "URL_BLOCKED",
    });
    expect(requested).toEqual(["news.example"]);
  });

  it("refuses a name that resolves to a private address", async () => {
    const deps: PageDeps = {
      lookup: async () => [{ address: "10.1.2.3", family: 4 }],
      request: async () => {
        throw new Error("request should not run");
      },
    };
    await expect(
      readPublicUrl("https://evil.example/a", deps)
    ).rejects.toBeInstanceOf(PublicUrlError);
    await expect(
      readPublicUrl("https://evil.example/a", deps)
    ).rejects.toMatchObject({ code: "URL_BLOCKED" });
  });

  it("reads plain text and gzipped html", async () => {
    const plain = await readPublicUrl("https://notes.example/a.txt", {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      request: async () => ({
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: Buffer.from(`${PROSE}\n`),
      }),
    });
    expect(plain.title).toBeNull();
    expect(plain.text).toContain("closed the ledger");

    const gzipped = await readPublicUrl("https://notes.example/a", {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      request: async () => ({
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "gzip",
        },
        body: zlib.gzipSync(Buffer.from(ARTICLE)),
      }),
    });
    expect(gzipped.title).toBe("Quay notes");
    expect(gzipped.text).toContain("lamps were lit");
  });

  it("reads the plain-text book linked from a short catalog page", async () => {
    const novel = `${"It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife. ".repeat(8)}`;
    const catalog = `<html><head><title>Pride and Prejudice by Jane Austen</title></head><body>
      <a href="/ebooks/1342.txt.utf-8">Plain Text</a>
      <p>A short catalog blurb about Elizabeth Bennet and Mr. Darcy, not the novel.</p>
    </body></html>`;
    const deps: PageDeps = {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      request: async (input) => {
        if (input.url.pathname.endsWith(".txt.utf-8")) {
          return {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: Buffer.from(
              `*** START OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***\n\n${novel}\n\n*** END OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***\n`
            ),
          };
        }
        return htmlResponse(catalog);
      },
    };
    const page = await readPublicUrl("https://www.gutenberg.org/ebooks/1342", deps);
    expect(page.title).toBe("Pride and Prejudice by Jane Austen");
    expect(page.text).toContain("truth universally acknowledged");
    expect(page.text).not.toContain("catalog blurb");
    expect(page.text).not.toContain("Project Gutenberg");
  });

  it("refuses a page that is only site navigation", async () => {
    const nav = `<html><body>
      <div><a>Log in</a></div>
      <div><a>Sign up</a></div>
      <div>My Books</div>
      <div>Subjects</div>
      <div>Trending</div>
      <div>Library Explorer</div>
      <p>Please verify you are human to continue.</p>
      <p>Verification failed. Please try again.</p>
    </body></html>`;
    await expect(
      readPublicUrl("https://library.example/works/1", {
        lookup: async () => [{ address: "1.1.1.1", family: 4 }],
        request: async () => htmlResponse(nav),
      })
    ).rejects.toMatchObject({ code: "URL_EMPTY" });
  });

  it("rejects a short page and a file that is not text", async () => {
    const deps = (body: PageResponse): PageDeps => ({
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      request: async () => body,
    });
    await expect(
      readPublicUrl(
        "https://notes.example/short",
        deps(htmlResponse("<p>Too short.</p>"))
      )
    ).rejects.toMatchObject({ code: "URL_EMPTY" });
    await expect(
      readPublicUrl(
        "https://notes.example/pic",
        deps({
          status: 200,
          headers: { "content-type": "image/jpeg" },
          body: Buffer.from([0xff, 0xd8, 0xff]),
        })
      )
    ).rejects.toMatchObject({ code: "URL_UNSUPPORTED" });
  });
});

describe("requestPublic", () => {
  it("reads a local page by the pinned address", async () => {
    const server = http.createServer((req, res) => {
      expect(req.url).toBe("/story?x=1");
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(ARTICLE);
    });
    const port = await listen(server);
    try {
      const response = await requestPublic({
        url: new URL(`http://127.0.0.1:${port}/story?x=1`),
        ip: "127.0.0.1",
        family: 4,
      });
      expect(response.status).toBe(200);
      expect(response.body.toString("utf8")).toContain("lamps were lit");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("stops when the response declares itself too large", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.setHeader("content-length", String(20 * 1024 * 1024));
      res.end("<p>nope</p>");
    });
    const port = await listen(server);
    try {
      await expect(
        requestPublic({
          url: new URL(`http://127.0.0.1:${port}/big`),
          ip: "127.0.0.1",
          family: 4,
        })
      ).rejects.toMatchObject({ code: "URL_TOO_LARGE" });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
