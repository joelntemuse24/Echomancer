import { expect, test, type Page } from "@playwright/test";

/**
 * Reproduces the phone + Google Drive upload failures from the owner report:
 * files picked from Drive arrive with an empty or octet-stream MIME, a
 * stripped extension, a lazily-reported size, or a read that fails after an
 * await (Android content:// NotReadableError). Every case must end in a
 * visible message or a completed upload — never a silent no-op.
 */

const PDF_BYTES = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n",
  "binary"
);

const TXT_BYTES = Buffer.from(
  "Chapter One\n\nThe lamps were lit along the quay and the tide was turning before midnight.\n",
  "utf-8"
);

function wavBytes(size = 16 * 1024): Buffer {
  const wav = Buffer.alloc(size);
  Buffer.from("RIFF").copy(wav, 0);
  Buffer.from("WAVE").copy(wav, 8);
  return wav;
}

async function pickState(page: Page) {
  return (await page.getByTestId("pick-state").innerText()).trim();
}

async function pickMessage(page: Page) {
  return (await page.getByTestId("pick-message").innerText()).trim();
}

async function serverRecords(page: Page) {
  const res = await page.request.get("/api/requests");
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as {
    requests: { method: string; url: string; body?: unknown; bytes?: number }[];
    clientLogs: { tag?: string; message?: string }[];
  };
}

test.beforeEach(async ({ page }) => {
  // The mock API records accumulate on the shared harness server; each
  // test starts from a clean slate.
  await page.request.delete("/api/requests");
});

test("a Drive-style PDF (no extension, empty MIME) picks, uploads, and completes", async ({
  page,
}) => {
  await page.goto("/book-upload");
  await page.setInputFiles("input[aria-label='Choose a book']", {
    name: "book",
    mimeType: "",
    buffer: PDF_BYTES,
  });

  await expect
    .poll(async () => pickState(page), { timeout: 10_000 })
    .toBe("book");
  await expect(page.getByTestId("pick-message")).toHaveText("");

  await page.getByTestId("submit").click();
  await expect
    .poll(async () => page.getByTestId("phase-log").innerText(), { timeout: 10_000 })
    .toContain("done");

  const log = (await page.getByTestId("phase-log").innerText()).trim();
  expect(log.startsWith("reading")).toBe(true);
  expect(log).toContain("uploading");
  expect(log).toContain("uploading:100");

  const { requests } = await serverRecords(page);
  const presign = requests.find((r) => r.url === "/api/pdf/upload");
  expect(presign?.body).toMatchObject({
    fileName: "book",
    // The sniffed type, not the empty MIME the Drive pick reported.
    contentType: "application/pdf",
    byteSize: PDF_BYTES.byteLength,
  });
  const sink = requests.find((r) => r.url.startsWith("/sink/"));
  expect(sink?.bytes).toBe(PDF_BYTES.byteLength);
});

test("an octet-stream MIME with a renamed .pdf name still uploads", async ({
  page,
}) => {
  await page.goto("/book-upload");
  await page.setInputFiles("input[aria-label='Choose a book']", {
    name: "Drive PDF.pdf",
    mimeType: "application/octet-stream",
    buffer: PDF_BYTES,
  });

  await expect.poll(async () => pickState(page)).toBe("Drive PDF.pdf");
  await page.getByTestId("submit").click();
  await expect
    .poll(async () => page.getByTestId("phase-log").innerText())
    .toContain("done");

  const { requests } = await serverRecords(page);
  expect(
    requests.find((r) => r.url === "/api/pdf/upload")?.body
  ).toMatchObject({ contentType: "application/pdf" });
});

test("a Google Doc pick shows the export-first message, not silence", async ({
  page,
}) => {
  await page.goto("/book-upload");
  await page.setInputFiles("input[aria-label='Choose a book']", {
    name: "My novel",
    mimeType: "application/vnd.google-apps.document",
    buffer: Buffer.from("{}"),
  });

  await expect
    .poll(async () => pickMessage(page))
    .toContain("download it as DOCX or PDF");
  await expect.poll(async () => pickState(page)).toBe("Your book");

  const { requests, clientLogs } = await serverRecords(page);
  expect(requests.some((r) => r.url === "/api/pdf/upload")).toBe(false);
  expect(clientLogs.some((c) => c.tag === "book-upload")).toBe(true);
});

test("an unreadable Drive pick (Android NotReadableError) is visible, logged, and never uploads", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/book-upload?failblob=1");
  await page.setInputFiles("input[aria-label='Choose a book']", {
    name: "book.pdf",
    mimeType: "application/pdf",
    buffer: PDF_BYTES,
  });

  await expect
    .poll(async () => pickMessage(page))
    .toContain("download it to your device");
  await expect.poll(async () => pickState(page)).toBe("Your book");

  // Logged in the browser console and on the server.
  expect(
    consoleErrors.some((line) => line.includes("[book-upload]"))
  ).toBe(true);
  const { requests, clientLogs } = await serverRecords(page);
  expect(requests.some((r) => r.url === "/api/pdf/upload")).toBe(false);
  expect(clientLogs.some((c) => c.tag === "book-upload")).toBe(true);
});

test("a read that fails after the pick (read-after-await) surfaces at upload time", async ({
  page,
}) => {
  await page.goto("/book-upload?failreader=1");
  await page.setInputFiles("input[aria-label='Choose a book']", {
    name: "book.pdf",
    mimeType: "application/pdf",
    buffer: PDF_BYTES,
  });

  // The pick itself validates fine; the failure comes at upload time.
  await expect.poll(async () => pickState(page)).toBe("book.pdf");
  await page.getByTestId("submit").click();

  await expect
    .poll(async () => pickMessage(page))
    .toContain("download it to your device");
  const log = (await page.getByTestId("phase-log").innerText()).trim();
  expect(log).toContain("reading");
  expect(log).not.toContain("uploading");

  const { requests } = await serverRecords(page);
  expect(requests.some((r) => r.url === "/api/pdf/upload")).toBe(false);
});

test("a lazy Drive download shows Reading… immediately and progress while uploading", async ({
  page,
}) => {
  await page.goto("/book-upload?slow=500");
  await page.setInputFiles("input[aria-label='Choose a book']", {
    name: "novel",
    mimeType: "application/octet-stream",
    buffer: TXT_BYTES,
  });

  // The reading state is visible while the picker fetches the file.
  await expect.poll(async () => pickState(page)).toBe("Reading…");
  await expect.poll(async () => pickState(page), { timeout: 10_000 }).toBe("novel");

  await page.getByTestId("submit").click();
  await expect
    .poll(async () => page.getByTestId("cta-label").innerText())
    .toBe("Reading…");
  await expect
    .poll(async () => page.getByTestId("phase-log").innerText(), { timeout: 10_000 })
    .toContain("done");
});

test("re-picking the same file still fires the change handler", async ({
  page,
}) => {
  await page.goto("/book-upload");
  const input = page.locator("input[aria-label='Choose a book']");
  await input.setInputFiles({
    name: "book.pdf",
    mimeType: "application/pdf",
    buffer: PDF_BYTES,
  });
  await expect.poll(async () => pickState(page)).toBe("book.pdf");
  await expect(page.getByTestId("pick-count")).toHaveText("1");

  // The input's value was cleared after the pick, so a real browser fires
  // change again when the same file is re-picked.
  const value = await input.evaluate(
    (el) => (el as HTMLInputElement).value
  );
  expect(value).toBe("");

  // Same file, second pick: the handler runs again.
  await input.setInputFiles({
    name: "book.pdf",
    mimeType: "application/pdf",
    buffer: PDF_BYTES,
  });
  await expect(page.getByTestId("pick-count")).toHaveText("2");
});

test("a nameless octet-stream WAV sample validates for cloning", async ({
  page,
}) => {
  await page.goto("/book-upload");
  await page.setInputFiles("input[aria-label='Choose a sample']", {
    name: "recording",
    mimeType: "application/octet-stream",
    buffer: wavBytes(),
  });

  await expect
    .poll(async () => page.getByTestId("clone-pick-state").innerText())
    .toBe("recording · wav");
  await expect(page.getByTestId("clone-pick-message")).toHaveText("");
});

test("a text file named .wav is rejected with a message, not silence", async ({
  page,
}) => {
  await page.goto("/book-upload");
  await page.setInputFiles("input[aria-label='Choose a sample']", {
    name: "voice.wav",
    mimeType: "",
    buffer: Buffer.from("just some words, not audio at all"),
  });

  await expect
    .poll(async () => page.getByTestId("clone-pick-message").innerText())
    .toContain("Use an audio or video file");
});
