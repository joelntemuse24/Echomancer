import { expect, test, type Page } from "@playwright/test";
import { LIVE_SECTION_SECONDS, startLiveGeneratingServer } from "./live-generating-server";

async function bookTime(page: Page): Promise<{ t: number; paused: boolean }> {
  return page.evaluate((sectionSeconds) => {
    const audio = document.querySelector("audio");
    const src = audio?.currentSrc || audio?.getAttribute("src") || "";
    const local = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const section = src.match(/sections\/(\d+)\.mp3/);
    const t = section ? Number(section[1]) * sectionSeconds + local : local;
    return { t, paused: audio ? audio.paused : true };
  }, LIVE_SECTION_SECONDS);
}

async function elementSrc(page: Page): Promise<string> {
  return page.evaluate(() => {
    const audio = document.querySelector("audio");
    return audio?.currentSrc || audio?.getAttribute("src") || "";
  });
}

/**
 * The clock moves for `ms` and does not jump back to the start. When
 * `holdSection` is set, a job poll that opens a Media Source fails even
 * if that source then seeks inside its own buffer. The next section file
 * is the part ending, not a reattach.
 */
async function playsOn(page: Page, ms: number, from: number, holdSection = false) {
  let previous = from;
  let advanced = from;
  const started = Date.now();
  while (Date.now() - started < ms) {
    await page.waitForTimeout(500);
    let row = await bookTime(page);
    if (row.paused) {
      await page.waitForTimeout(800);
      row = await bookTime(page);
    }
    expect(row.paused, `paused at ${row.t.toFixed(2)}`).toBe(false);
    expect(row.t + 1, `playhead rewound from ${previous.toFixed(2)} to ${row.t.toFixed(2)}`).toBeGreaterThanOrEqual(
      previous
    );
    if (holdSection) {
      const src = await elementSrc(page);
      expect(src, "live source reattached").not.toMatch(/^blob:/);
      expect(src, "left the section file").toContain("/sections/");
    }
    if (row.t > advanced) advanced = row.t;
    previous = row.t;
  }
  expect(advanced).toBeGreaterThan(from + ms / 1000 - 8);
}

async function scrubTo(page: Page, fraction: number) {
  const slider = page.locator("[data-slot=slider]");
  await expect.poll(async () => (await slider.boundingBox())?.width ?? 0).toBeGreaterThan(200);
  const box = await slider.boundingBox();
  if (!box) throw new Error("seek bar has no box");
  const x = box.x + box.width * fraction;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.up();
}

async function statusMark(page: Page): Promise<number | null> {
  const text = await page.locator("body").innerText();
  const mark = text.match(/mark (\d+)/);
  return mark ? Number(mark[1]) : null;
}

/**
 * Desktop Chrome reports MediaSource audio/mpeg and a non-empty HLS
 * canPlayType. A generating book publishes live.m3u8 as a page path. The
 * player used to resolve each segment against that path, the URL constructor
 * threw, and every job poll reloaded the section at 0:00 and paused.
 */
test("a generating book plays for a minute while job polls arrive", async ({ page }) => {
  test.setTimeout(90_000);
  const server = await startLiveGeneratingServer();
  try {
    await page.goto(server.url);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    let previous = 0;
    let heard = false;
    const started = Date.now();
    while (Date.now() - started < 62_000) {
      await page.waitForTimeout(500);
      const row = await page.evaluate(() => {
        const audio = document.querySelector("audio");
        return {
          t: audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
          paused: audio ? audio.paused : true,
        };
      });
      if (!heard) {
        if (!row.paused && row.t > 0.2) {
          heard = true;
          previous = row.t;
        }
        continue;
      }
      expect(row.paused, `paused at ${row.t.toFixed(2)}`).toBe(false);
      expect(row.t + 0.5, `playhead rewound from ${previous.toFixed(2)} to ${row.t.toFixed(2)}`).toBeGreaterThanOrEqual(
        previous
      );
      previous = row.t;
    }
    expect(heard).toBe(true);
    expect(previous).toBeGreaterThan(55);
  } finally {
    await server.close();
  }
});

test("a parts tap past the appended audio plays on, and the job poll keeps moving", async ({ page }) => {
  test.setTimeout(90_000);
  const server = await startLiveGeneratingServer({ initialReady: 12, total: 12, growMs: 0 });
  try {
    await page.goto(server.url);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => bookTime(page).then((row) => row.t)).toBeGreaterThan(0.4);
    const before = await statusMark(page);
    await page.getByRole("button", { name: "Parts" }).click();
    await page.getByRole("button", { name: "09Ready" }).click();
    await expect.poll(() => bookTime(page).then((row) => row.t)).toBeGreaterThan(100);
    const landed = await bookTime(page);
    const held = await elementSrc(page);
    expect(held).toContain("/sections/0008.mp3");
    expect(held.startsWith("blob:")).toBe(false);
    await playsOn(page, 30_000, landed.t, true);
    const after = await statusMark(page);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after!).toBeGreaterThan(before!);
  } finally {
    await server.close();
  }
});

test("a parts tap to 60 seconds, inside 45 to 90, stays on that section", async ({ page }) => {
  test.setTimeout(90_000);
  const server = await startLiveGeneratingServer({ initialReady: 12, total: 12, growMs: 0 });
  try {
    await page.goto(server.url);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => bookTime(page).then((row) => row.t)).toBeGreaterThan(0.4);
    const before = await elementSrc(page);
    expect(before.startsWith("blob:")).toBe(true);
    await page.getByRole("button", { name: "Parts" }).click();
    // Part 04 starts at 45s, which this harness has already appended. Part 05
    // starts at 60s, still inside 45–90 and past that window.
    await page.getByRole("button", { name: "05Ready" }).click();
    await expect.poll(() => bookTime(page).then((row) => row.t)).toBeGreaterThan(55);
    const landed = await bookTime(page);
    expect(landed.t).toBeLessThan(90);
    const held = await elementSrc(page);
    expect(held).toContain("/sections/0004.mp3");
    expect(held.startsWith("blob:")).toBe(false);
    expect(held).not.toBe(before);
    await playsOn(page, 30_000, landed.t, true);
  } finally {
    await server.close();
  }
});

test("a scrub past the appended audio plays on", async ({ page }) => {
  test.setTimeout(90_000);
  const server = await startLiveGeneratingServer({ initialReady: 12, total: 12, growMs: 0 });
  try {
    await page.goto(server.url);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => bookTime(page).then((row) => row.t)).toBeGreaterThan(0.4);
    await scrubTo(page, 0.62);
    await expect.poll(() => bookTime(page).then((row) => row.t), { timeout: 10_000 }).toBeGreaterThan(90);
    const landed = await bookTime(page);
    const held = await elementSrc(page);
    expect(held).toContain("/sections/");
    expect(held.startsWith("blob:")).toBe(false);
    await playsOn(page, 30_000, landed.t, true);
  } finally {
    await server.close();
  }
});

test("a reload mid-generation resumes at the saved point and plays for a minute", async ({ page }) => {
  test.setTimeout(150_000);
  const server = await startLiveGeneratingServer({ initialReady: 12, total: 12, growMs: 0 });
  try {
    await page.goto(server.url);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => bookTime(page).then((row) => row.t)).toBeGreaterThan(0.4);
    await scrubTo(page, 0.55);
    await expect
      .poll(async () => {
        const raw = await page.evaluate(() => localStorage.getItem("ec-resume:live-book"));
        if (!raw) return 0;
        const saved = JSON.parse(raw) as { positionSeconds?: number };
        return typeof saved.positionSeconds === "number" ? saved.positionSeconds : 0;
      }, { timeout: 15_000 })
      .toBeGreaterThan(90);
    const saved = await page.evaluate(() => {
      const raw = localStorage.getItem("ec-resume:live-book");
      return raw ? (JSON.parse(raw) as { positionSeconds: number }).positionSeconds : 0;
    });
    await page.reload();
    await expect
      .poll(() => bookTime(page).then((row) => row.t), { timeout: 20_000 })
      .toBeGreaterThan(saved - 8);
    const resumed = await bookTime(page);
    expect(resumed.t).toBeLessThan(saved + 20);
    if (resumed.paused) await page.getByRole("button", { name: "Play", exact: true }).click();
    const held = await elementSrc(page);
    expect(held).toContain("/sections/");
    expect(held.startsWith("blob:")).toBe(false);
    await playsOn(page, 60_000, (await bookTime(page)).t, true);
  } finally {
    await server.close();
  }
});

test("the section count keeps updating while audio is playing", async ({ page }) => {
  test.setTimeout(60_000);
  const server = await startLiveGeneratingServer({ initialReady: 4, total: 12, growMs: 2000 });
  try {
    await page.goto(server.url);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => bookTime(page).then((row) => !row.paused && row.t > 0.3)).toBe(true);
    const first = await page.locator("body").innerText();
    const start = first.match(/(\d+) of 12/);
    expect(start).not.toBeNull();
    await expect
      .poll(async () => {
        const text = await page.locator("body").innerText();
        const next = text.match(/(\d+) of 12/);
        const playing = await bookTime(page);
        return Boolean(next && Number(next[1]) > Number(start![1]) && !playing.paused && playing.t > 1);
      }, { timeout: 20_000 })
      .toBe(true);
  } finally {
    await server.close();
  }
});
