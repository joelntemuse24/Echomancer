import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => { await page.goto("/"); });

test("keyboard passage seek and bounded long transcript navigation", async ({ page }) => {
  await expect(page.locator("[data-block]")).toHaveCount(80);
  const passage = page.getByRole("button", { name: /^Play from Passage 0\./ });
  await passage.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("seek")).toHaveText("0");
  await page.getByRole("button", { name: "Next passages" }).click();
  await expect(page.locator("[data-block]").first()).toHaveAttribute("data-block", "80");
  await page.getByRole("button", { name: "Follow along" }).click();
  await expect(page.locator("[data-block]").first()).toHaveAttribute("data-block", "0");
  await page.getByRole("button", { name: "Advance audio" }).click();
  await expect(page.locator("[data-block='180']")).toBeAttached();
  await expect(page.locator("[data-block]")).toHaveCount(80);
});

for (const input of ["wheel", "keyboard"]) {
  test(`${input} pauses follow until explicitly resumed`, async ({ page }) => {
    const region = page.getByRole("region", { name: "Read along transcript" });
    if (input === "wheel") {
      await region.hover();
      await page.mouse.wheel(0, 200);
    } else {
      await region.focus();
      await page.keyboard.press("PageDown");
    }
    await expect(page.getByRole("button", { name: "Follow along" })).toBeVisible();
    await page.getByRole("button", { name: "Advance audio" }).click();
    await expect(page.locator("[data-block]").first()).toHaveAttribute("data-block", "0");
    await page.getByRole("button", { name: "Follow along" }).click();
    await expect(page.locator("[data-block='180']")).toBeAttached();
  });
}

test("streams explicitly show unsynchronized text without seek controls", async ({ page }) => {
  await page.getByRole("button", { name: "Stream", exact: true }).click();
  await expect(page.getByRole("note")).toHaveText("Stream transcript is not synchronized with audio.");
  await expect(page.getByRole("button", { name: /^Play from/ })).toHaveCount(0);
});

async function mockMedia(page: Page) {
  await page.addInitScript(() => {
    const state = new WeakMap<HTMLMediaElement, { time: number; paused: boolean }>();
    const forMedia = (media: HTMLMediaElement) => {
      let value = state.get(media);
      if (!value) { value = { time: 0, paused: true }; state.set(media, value); }
      return value;
    };
    Object.defineProperties(HTMLMediaElement.prototype, {
      duration: { get() { return this.src.includes("full") ? 128 : this.src.includes("1.mp3") ? 50 : 20; } },
      currentTime: { get() { return forMedia(this).time; }, set(value) { forMedia(this).time = value; this.dispatchEvent(new Event("timeupdate")); } },
      paused: { get() { return forMedia(this).paused; } },
      readyState: { get() { return 4; } },
    });
    HTMLMediaElement.prototype.play = async function () { forMedia(this).paused = false; this.dispatchEvent(new Event("play")); };
    HTMLMediaElement.prototype.pause = function () { forMedia(this).paused = true; this.dispatchEvent(new Event("pause")); };
    const metadata = (media: HTMLMediaElement) => {
      forMedia(media).time = 0;
      forMedia(media).paused = true;
      media.dispatchEvent(new Event("loadedmetadata"));
      media.dispatchEvent(new Event("canplay"));
    };
    HTMLMediaElement.prototype.load = function () { metadata(this); };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof HTMLMediaElement) metadata(record.target);
        for (const node of record.addedNodes) if (node instanceof HTMLMediaElement) metadata(node);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
  });
}

function auditJob(ready: boolean) {
  return { id: "audit-book", book_title: "Audit book", voice_name: "Andrew",
    status: ready ? "ready" : "processing", progress: ready ? 100 : 50,
    current_section: ready ? 3 : 2, total_sections: 3, duration_seconds: ready ? 128 : null,
    audio_url: ready ? "/api/storage/full.mp3" : null,
    segments: [0, 1, 2].map((index) => ({ index, path: `audit/sections/${index}.mp3`, status: "ready" })),
  };
}

async function audioTime(page: Page) {
  return page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime);
}

test("real player refreshes on finalization, preserves unequal-section position and shares requests", async ({ page }) => {
  await mockMedia(page);
  let ready = false;
  let transcriptRequests = 0;
  const frozenSections = ["First section.", "Second section.", "Third section."].map((text, index) => ({ text, index }));
  await page.route("**/api/jobs/audit-book", (route) => route.fulfill({ json: { job: auditJob(ready) } }));
  await page.route("**/api/jobs/audit-book/transcript", (route) => {
    transcriptRequests++;
    return route.fulfill({ json: fixtureDocument(frozenSections, ready ? [0, 8, 108, 128] : null) });
  });
  await page.goto("/player");
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await page.getByRole("button", { name: "Play from Second section." }).click();
  await expect(page.locator("audio")).toHaveAttribute("src", /1\.mp3/);
  await page.locator("audio").evaluate((audio: HTMLAudioElement) => { audio.currentTime = 25; });
  ready = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("audio")).toHaveAttribute("src", "/api/storage/full.mp3");
  await expect.poll(() => audioTime(page)).toBe(58);
  expect(transcriptRequests).toBe(2);
  await page.getByRole("button", { name: "Hide transcript" }).click();
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  expect(transcriptRequests).toBe(2);
});

test("real player retries transcript failures and seeks missing-timing sections from destination start", async ({ page }) => {
  await mockMedia(page);
  let requests = 0;
  const doc = fixtureDocument([
    { index: 0, text: "First section." }, { index: 1, text: "Second section." },
  ]);
  await page.route("**/api/jobs/audit-book", (route) => route.fulfill({ json: { job: auditJob(false) } }));
  await page.route("**/api/jobs/audit-book/transcript", (route) => {
    requests++;
    return requests === 1 ? route.fulfill({ status: 503, body: "unavailable" }) : route.fulfill({ json: doc });
  });
  await page.goto("/player?mode=segments");
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(page.getByText("Couldn't refresh the transcript.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play from Second section." })).toBeVisible();
  await page.getByRole("button", { name: "Play from Second section." }).click();
  await expect(page.locator("audio")).toHaveAttribute("src", /1\.mp3/);
  await expect.poll(() => audioTime(page)).toBe(0);
  expect(requests).toBe(2);
});

test("real live stream follows media time through pause, rate change, seek and reconnect", async ({ page }) => {
  await mockMedia(page);
  const doc = fixtureDocument([
    { index: 0, text: "Opening line. The harbor woke." }, { index: 1, text: "Second window text." },
    { index: 2, text: "Third window text." },
  ]);
  const windows = doc.blocks.map((block) => ({ start: block.charStart, end: block.charEnd }));
  let stream: { conn: string | null; windows: Array<{ start: number; end: number; seconds: number | null }> } | null = null;
  const job = () => ({ id: "audit-book", book_title: "Stream book", voice_name: "Andrew", status: "queued",
    progress: 10, current_section: 0, total_sections: 0, duration_seconds: null, job_kind: "stream",
    stream_url: "/api/jobs/audit-book/stream", stream_cursor: 9999, stream_chars_used: 100, stream_max_chars: 5000,
    stream_timeline: stream });
  await page.route("**/api/jobs/audit-book", (route) => route.fulfill({ json: { job: job() } }));
  await page.route("**/api/jobs/audit-book/transcript", (route) => route.fulfill({ json: doc }));
  const conn = () => page.locator("audio").evaluate((audio: HTMLAudioElement) =>
    new URL(audio.getAttribute("src")!, location.href).searchParams.get("conn"));
  const poll = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const setTime = (seconds: number) =>
    page.locator("audio").evaluate((audio: HTMLAudioElement, at) => { audio.currentTime = at; }, seconds);
  const activeBlock = () => page.locator("[data-block].text-foreground").first().getAttribute("data-block");

  await page.goto("/player?mode=stream");
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect(page.getByRole("note")).toHaveText("Stream transcript is not synchronized with audio.");
  await expect.poll(conn).toMatch(/^[0-9a-z]{8,}$/);
  const first = (await conn())!;

  // Plan only: nothing measured, so the highlight rests on the first window.
  stream = { conn: first, windows: windows.map((w) => ({ ...w, seconds: null })) };
  await poll();
  await expect(page.getByRole("note")).toHaveCount(0);
  await setTime(40);
  await expect.poll(activeBlock).toBe("0");

  // Lengths arrive: 20 s, 10 s, 6 s.
  stream = { conn: first, windows: windows.map((w, i) => ({ ...w, seconds: [20, 10, 6][i]! })) };
  await poll();
  await setTime(21);
  await expect.poll(activeBlock).toBe("1");
  // The delivery cursor sits at the end of the book and must not matter.
  await page.locator("audio").evaluate((audio: HTMLAudioElement) => { audio.playbackRate = 1.5; audio.pause(); });
  await expect.poll(activeBlock).toBe("1");
  await setTime(31);
  await expect.poll(activeBlock).toBe("2");
  await setTime(5);
  await expect.poll(activeBlock).toBe("0");

  // Reconnect: the old clock stops applying until the new connection writes its own.
  await page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.dispatchEvent(new Event("ended")));
  await expect.poll(async () => (await conn()) !== first).toBe(true);
  // The listener keeps their place while the new connection plans its windows.
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect.poll(activeBlock).toBe("0");
  const second = (await conn())!;
  stream = { conn: second, windows: windows.slice(1).map((w) => ({ ...w, seconds: 10 })) };
  await poll();
  await expect(page.getByRole("note")).toHaveCount(0);
  await setTime(1);
  await expect.poll(activeBlock).toBe("1");
});

function fixtureDocument(frozen: Array<{ index: number; text: string }>, clock: number[] | null = null) {
  let cursor = 0;
  const sections = frozen.map((section, i) => {
    const charStart = cursor;
    cursor += section.text.length + 2;
    return { index: section.index, charStart, charEnd: cursor - 2,
      startSeconds: clock?.[i] ?? null,
      durationSeconds: clock ? clock[i + 1]! - clock[i]! : null,
      sentences: [{ start: 0, weight: section.text.length, pauseAfter: 0 }] };
  });
  return { charCount: cursor - 2, sections,
    blocks: frozen.map((section, i) => ({ id: `b${i}`, kind: "paragraph", level: 1,
      text: section.text, charStart: sections[i]!.charStart, charEnd: sections[i]!.charEnd,
      sectionIndex: section.index })) };
}
