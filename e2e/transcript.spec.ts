import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => { await page.goto("/"); });

const region = (page: Page) => page.getByRole("region", { name: "Read along transcript" });
const activeBlock = (page: Page) => page.locator("[data-block][data-state='current']").first();

/* ------------------------------------------------------------------ */
/* Follow, pause, resume                                               */
/* ------------------------------------------------------------------ */

test("follows the audio: the active passage stays in the middle of the view", async ({ page }) => {
  await expect(region(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Following the audio" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => activeBlock(page).getAttribute("data-block")).toBe("0");

  await page.getByRole("button", { name: "Advance audio" }).click();
  await expect.poll(() => activeBlock(page).getAttribute("data-block")).toBe("180");
  // The mounted slice followed the playhead, and the passage is on screen.
  await expect(page.locator("[data-block='180']")).toBeInViewport();

  await page.getByRole("button", { name: "Next minute" }).click();
  await expect.poll(() => activeBlock(page).getAttribute("data-block")).toBe("186");
  await expect(page.locator("[data-block='186']")).toBeInViewport();
});

test("a manual scroll pauses follow, and Back to now resumes it", async ({ page }) => {
  await page.getByRole("button", { name: "Advance audio" }).click();
  await expect.poll(() => activeBlock(page).getAttribute("data-block")).toBe("180");

  await region(page).hover();
  await page.mouse.wheel(0, 400);
  await expect(page.getByRole("button", { name: "Follow is paused" }))
    .toHaveAttribute("aria-pressed", "false");
  // The highlight keeps moving, but the view stays where the reader left it.
  await page.getByRole("button", { name: "Next minute" }).click();
  await expect.poll(() => activeBlock(page).getAttribute("data-block")).toBe("186");
  await page.getByRole("button", { name: "Back to now" }).click();
  await expect(page.getByRole("button", { name: "Following the audio" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-block='186']")).toBeInViewport();
});

test("following resumes on its own after eight quiet seconds", async ({ page }) => {
  await region(page).hover();
  await page.mouse.wheel(0, 400);
  await expect(page.getByRole("button", { name: "Follow is paused" })).toBeVisible();
  await page.getByRole("button", { name: "Advance audio" }).click();
  await expect(page.getByRole("button", { name: "Following the audio" })).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 12_000 }
  );
  await expect(page.locator("[data-block='180']")).toBeInViewport();
});

test("keyboard scrolling pauses follow too", async ({ page }) => {
  await region(page).focus();
  await page.keyboard.press("PageDown");
  await expect(page.getByRole("button", { name: "Follow is paused" })).toBeVisible();
});

test("the follow preference is remembered", async ({ page }) => {
  // The header toggle is the deliberate pause: no idle timer, so it stays
  // paused until the reader resumes it, and it survives a reload.
  await page.getByRole("button", { name: "Following the audio" }).click();
  await expect(page.getByRole("button", { name: "Follow is paused" }))
    .toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(page.getByRole("button", { name: "Follow is paused" }))
    .toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Back to now" })).toBeVisible();
  await page.getByRole("button", { name: "Back to now" }).click();
  await expect(page.getByRole("button", { name: "Following the audio" }))
    .toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: "Following the audio" }))
    .toHaveAttribute("aria-pressed", "true");
});

/* ------------------------------------------------------------------ */
/* Tap to seek                                                         */
/* ------------------------------------------------------------------ */

test("a tap inside a paragraph seeks to the tapped words and keeps following", async ({ page }) => {
  const paragraph = page.locator("[data-block='0']");
  await expect(paragraph).toBeVisible();
  const box = (await paragraph.boundingBox())!;
  // About a third of the way across the first paragraph.
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height / 2);
  const seek = Number(await page.getByTestId("seek").textContent());
  // "Passage 0. The harbor was quiet." — the tap lands inside it, not on 0.
  expect(seek).toBeGreaterThan(0);
  expect(seek).toBeLessThan(29);
});

test("a tap on an upcoming paragraph jumps the highlight forward", async ({ page }) => {
  const target = page.locator("[data-block='5']");
  await target.scrollIntoViewIfNeeded();
  await target.click({ position: { x: 8, y: 8 } });
  await expect.poll(() => activeBlock(page).getAttribute("data-block")).toBe("5");
});

test("the paragraph control still plays from its first word", async ({ page }) => {
  await page.getByRole("button", { name: /^Play from Passage 1\./ }).click();
  // "Passage 0. The harbor was quiet." is 32 characters; the next paragraph
  // starts two characters later, after its blank-line separator.
  await expect(page.getByTestId("seek")).toHaveText("34");
  await expect.poll(() => activeBlock(page).getAttribute("data-block")).toBe("1");
});

/* ------------------------------------------------------------------ */
/* Focus (full-screen) mode                                            */
/* ------------------------------------------------------------------ */

test("focus mode fills the viewport with a slim player bar, and Esc exits", async ({ page }) => {
  await page.getByRole("button", { name: "Focus mode" }).click();
  const focus = page.getByRole("dialog", { name: "Read along, focus mode" });
  await expect(focus).toBeVisible();
  const viewport = page.viewportSize()!;
  const box = (await focus.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(viewport.width - 1);
  expect(box.height).toBeGreaterThanOrEqual(viewport.height - 1);
  await expect(focus.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(focus.getByRole("button", { name: "Back 15 seconds" })).toBeVisible();
  await expect(focus.getByRole("button", { name: "Forward 15 seconds" })).toBeVisible();
  await expect(focus.getByRole("slider").first()).toBeVisible();
  await expect(focus.getByRole("button", { name: "Playback speed" })).toHaveText("1.15×");
  await expect(focus.getByText("Chapter One")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(focus).toHaveCount(0);
});

test("focus mode is remembered and can be left with the close control", async ({ page }) => {
  await page.getByRole("button", { name: "Focus mode" }).click();
  const focus = page.getByRole("dialog", { name: "Read along, focus mode" });
  await expect(focus).toBeVisible();
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Read along, focus mode" })).toBeVisible();
  await page.getByRole("button", { name: "Close focus mode" }).click();
  await expect(page.getByRole("dialog", { name: "Read along, focus mode" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Read along, focus mode" })).toHaveCount(0);
});

test("focus mode keeps the transcript following the audio", async ({ page }) => {
  await page.getByRole("button", { name: "Focus mode" }).click();
  const focus = page.getByRole("dialog", { name: "Read along, focus mode" });
  await expect(focus).toBeVisible();
  // The overlay covers the page, so drive the fixture directly.
  await page.getByRole("button", { name: "Advance audio" }).dispatchEvent("click");
  await expect.poll(() => activeBlock(page).getAttribute("data-block")).toBe("180");
  await expect(page.locator("[data-block='180']")).toBeInViewport();
});

test("focus mode hides the precise scrubber behind the same disclosure", async ({ page }) => {
  await page.getByRole("button", { name: "Focus mode" }).click();
  const focus = page.getByRole("dialog", { name: "Read along, focus mode" });
  await expect(focus).toBeVisible();

  const disclosure = focus.getByTestId("precise-seek-toggle");
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  // One slider only: the main bar.
  await expect(focus.locator("[data-slot='slider']")).toHaveCount(1);

  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(focus.locator("[data-slot='slider']")).toHaveCount(2);

  // Closing the overlay and reopening it keeps the listener's choice.
  await page.getByRole("button", { name: "Close focus mode" }).click();
  await page.getByRole("button", { name: "Focus mode" }).click();
  await expect(
    page.getByRole("dialog", { name: "Read along, focus mode" }).getByTestId("precise-seek-toggle")
  ).toHaveAttribute("aria-expanded", "true");
});

test("a phone-sized screen keeps the reading column comfortable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Focus mode" }).click();
  const focus = page.getByRole("dialog", { name: "Read along, focus mode" });
  await expect(focus).toBeVisible();
  const box = (await focus.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(390);
  await expect(focus.getByRole("button", { name: "Close focus mode" })).toBeInViewport();
  await expect(focus.getByRole("button", { name: "Play", exact: true })).toBeInViewport();
  // The reading column stays inside a comfortable measure on a narrow screen.
  const paragraph = page.locator("[data-block][data-state='current']").first();
  const paragraphBox = (await paragraph.boundingBox())!;
  expect(paragraphBox.width).toBeLessThanOrEqual(390 - 24);
});

test("prefers-reduced-motion turns the smooth scroll off", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Advance audio" }).click();
  // Nothing to assert about the animation itself, but the highlight must
  // still land on screen in one jump.
  await expect(page.locator("[data-block='180']")).toBeInViewport();
  const scrolled = await region(page).evaluate((node) => node.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
});

test("streams explicitly show unsynchronized text without seek controls", async ({ page }) => {
  await page.getByRole("button", { name: "Stream", exact: true }).click();
  await expect(page.getByRole("note")).toHaveText("Stream transcript is not synchronized with audio.");
  await expect(page.getByRole("button", { name: /^Play from/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to now" })).toHaveCount(0);
});

/* ------------------------------------------------------------------ */
/* The real player page                                                */
/* ------------------------------------------------------------------ */

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

test("real player maps a tap inside the playing section onto that section file", async ({ page }) => {
  await mockMedia(page);
  // Section 1's own file is 50 s; the book is 128 s. A tap in the back half
  // of its text must land in the back half of *the file*, not of the book.
  const doc = fixtureDocument([
    { index: 0, text: "First section." },
    { index: 1, text: "Second section has a second sentence after a full stop." },
  ]);
  // A real book knows its full length (128 s) while each section file is much
  // shorter. That gap is exactly what a naive scale confuses.
  const job = { ...auditJob(false), duration_seconds: 128 };
  await page.route("**/api/jobs/audit-book", (route) => route.fulfill({ json: { job } }));
  await page.route("**/api/jobs/audit-book/transcript", (route) => route.fulfill({ json: doc }));
  await page.goto("/player?mode=segments");
  await page.getByRole("button", { name: "Transcript", exact: true }).click();
  await page.getByRole("button", { name: /^Play from Second section/ }).click();
  await expect(page.locator("audio")).toHaveAttribute("src", /1\.mp3/);
  await expect.poll(() => audioTime(page)).toBe(0);

  // A mid-paragraph tap is what exercises the scaling.
  const paragraph = page.locator("[data-block='1']");
  const box = (await paragraph.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  const at = await audioTime(page);
  // Inside the 50 s section file, and well short of the whole book.
  expect(at).toBeGreaterThan(0);
  expect(at).toBeLessThan(50);
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

// Android Chrome often skips preloading, so audio.duration stays NaN and
// readyState 0 until the listener presses play. The bar must still seek.
for (const kind of ["desktop", "mobile"] as const) {
  test.describe(`${kind} main seek bar before metadata`, () => {
    if (kind === "mobile") {
      test.use({ viewport: { width: 412, height: 839 }, hasTouch: true, isMobile: true });
    }

    test("tap and drag land on the stored-duration position, applied once metadata loads", async ({ page }) => {
      await mockMedia(page);
      await page.addInitScript(() => {
        const w = window as unknown as { __meta: boolean };
        w.__meta = false;
        Object.defineProperties(HTMLMediaElement.prototype, {
          duration: { get() { return w.__meta ? 128 : NaN; } },
          readyState: { get() { return w.__meta ? 4 : 0; } },
        });
      });
      await page.route("**/api/jobs/audit-book", (route) => route.fulfill({ json: { job: auditJob(true) } }));
      await page.route("**/api/jobs/audit-book/transcript", (route) => route.fulfill({ status: 404, body: "" }));
      await page.goto("/player");
      const slider = page.locator("[data-slot='slider']").first();
      await expect(slider.getByRole("slider")).toHaveAttribute("aria-valuemax", "128");
      const box = (await slider.boundingBox())!;
      const y = box.y + box.height / 2;
      const at = (fraction: number) => box.x + box.width * fraction;
      const tap = (x: number) => kind === "mobile" ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);

      await tap(at(0.25));
      await expect(slider.getByRole("slider")).toHaveAttribute("aria-valuenow", /^(31|32)(\.\d+)?$/);
      if (kind === "mobile") {
        const client = await page.context().newCDPSession(page);
        await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at(0.25), y, id: 0 }] });
        for (let i = 1; i <= 10; i++) {
          await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: at(0.25 + 0.5 * i / 10), y, id: 0 }] });
        }
        await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await page.mouse.move(at(0.25), y);
        await page.mouse.down();
        await page.mouse.move(at(0.75), y, { steps: 10 });
        await page.mouse.up();
      }
      await expect(slider.getByRole("slider")).toHaveAttribute("aria-valuenow", /^(95|96|97)(\.\d+)?$/);

      // The browser finally loads the file: the held seek is applied to it.
      await page.evaluate(() => {
        (window as unknown as { __meta: boolean }).__meta = true;
        document.querySelector("audio")!.dispatchEvent(new Event("loadedmetadata"));
      });
      await expect.poll(() => audioTime(page)).toBeGreaterThan(94);
      expect(await audioTime(page)).toBeLessThan(98);
    });
  });
}

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
