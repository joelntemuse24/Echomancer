import { expect, test, type Locator, type Page } from "@playwright/test";

type PointerKind = "mouse" | "touch";

const LONG = 60 * 60;
const SHORT = 5 * 60;
const ALWAYS = 30 * 60;
const WINDOW = 120;

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  kind: PointerKind
) {
  if (kind === "mouse") {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    return;
  }
  const client = await page.context().newCDPSession(page);
  const steps = 12;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y, id: 0 }],
  });
  for (let i = 1; i <= steps; i += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
          id: 0,
        },
      ],
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
}

async function tap(page: Page, locator: Locator, kind: PointerKind) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("missing tap target");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (kind === "mouse") {
    await page.mouse.click(x, y);
    return;
  }
  await page.touchscreen.tap(x, y);
}

function fineThumb(page: Page) {
  return page.locator("[data-slot='slider-thumb']").nth(1);
}

function mainThumb(page: Page) {
  return page.locator("[data-slot='slider-thumb']").nth(0);
}

async function expectFineUp(page: Page) {
  await expect(page.locator("[data-slot='slider-thumb']")).toHaveCount(2);
  await expect(fineThumb(page)).toBeVisible();
}

async function expectFineDown(page: Page) {
  await expect(page.locator("[data-slot='slider-thumb']")).toHaveCount(1);
}

/** Slider roots carry data-slot="slider"; the fine bar is the second one. */
function sliderRoot(page: Page, index: number) {
  return page.locator("[data-slot='slider']").nth(index);
}

async function fineBounds(page: Page) {
  const thumb = fineThumb(page);
  return {
    start: Number(await thumb.getAttribute("aria-valuemin")),
    end: Number(await thumb.getAttribute("aria-valuemax")),
  };
}

async function clock(page: Page) {
  return Number((await page.getByTestId("clock").innerText()).trim());
}

async function commits(page: Page) {
  const text = (await page.getByTestId("commits").innerText()).trim();
  return text ? text.split(",").map(Number) : [];
}

/** Drag the main bar so the drag lands near `fraction` of its width. */
async function seekTo(page: Page, kind: PointerKind, fraction: number) {
  const box = await sliderRoot(page, 0).boundingBox();
  if (!box) throw new Error("missing seek bar");
  const y = box.y + box.height / 2;
  const target = box.x + box.width * fraction;
  const from = box.x + box.width * Math.max(0.05, fraction - 0.2);
  await drag(page, { x: from, y }, { x: target, y }, kind);
}

async function dragFineThumb(page: Page, kind: PointerKind, dx: number) {
  const thumb = fineThumb(page);
  await thumb.scrollIntoViewIfNeeded();
  const box = await thumb.boundingBox();
  if (!box) throw new Error("missing fine thumb");
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await drag(page, from, { x: from.x + dx, y: from.y }, kind);
}

function exercise(kind: PointerKind) {
  test("long audio shows fine tune from load and never drops it", async ({ page }) => {
    await page.goto(`/player?d=${LONG}`);
    await expectFineUp(page);
    await expect(page.getByText("Fine tune 0:00–2:00")).toBeVisible();

    // Tap anywhere else — it stays.
    await tap(page, page.getByTestId("elsewhere"), kind);
    await expectFineUp(page);

    // Let it play: the window slides forward with the playhead.
    await tap(page, page.getByTestId("toggle"), kind);
    await expect
      .poll(async () => (await fineBounds(page)).start)
      .toBeGreaterThan(0);
    const playing = await fineBounds(page);
    expect(playing.end - playing.start).toBe(WINDOW);
    await tap(page, page.getByTestId("toggle"), kind);

    // A normal seek recentres the window on the landing spot.
    await seekTo(page, kind, 0.5);
    await expect
      .poll(async () => (await fineBounds(page)).start)
      .toBeGreaterThan(LONG / 2 - WINDOW);
    const afterSeek = await fineBounds(page);
    expect(afterSeek.end - afterSeek.start).toBe(WINDOW);
    const afterClock = await clock(page);
    expect(afterClock).toBeGreaterThanOrEqual(afterSeek.start);
    expect(afterClock).toBeLessThanOrEqual(afterSeek.end);
    expect(await commits(page)).toHaveLength(1);

    // One fine adjustment commits and leaves the slider up.
    await dragFineThumb(page, kind, 60);
    const fineCommits = await commits(page);
    expect(fineCommits).toHaveLength(2);
    expect(fineCommits[1]).toBeGreaterThan(fineCommits[0]);
    expect(fineCommits[1]).toBeGreaterThanOrEqual(afterSeek.start);
    expect(fineCommits[1]).toBeLessThanOrEqual(afterSeek.end);
    await expectFineUp(page);

    // Tapping elsewhere still does not dismiss it.
    await tap(page, page.getByTestId("elsewhere"), kind);
    await expectFineUp(page);
  });

  test("short audio lifts fine tune on the first scrub and keeps it", async ({ page }) => {
    await page.goto(`/player?d=${SHORT}`);
    await expectFineDown(page);

    await seekTo(page, kind, 0.5);
    await expectFineUp(page);
    const revealed = await fineBounds(page);
    expect(revealed.end - revealed.start).toBe(WINDOW);
    expect(revealed.start).toBeGreaterThan(0);

    // Tap elsewhere — it stays for the rest of the visit.
    await tap(page, page.getByTestId("elsewhere"), kind);
    await expectFineUp(page);

    // Let it play: the window keeps tracking the playhead.
    await tap(page, page.getByTestId("toggle"), kind);
    await expect
      .poll(async () => (await fineBounds(page)).start)
      .toBeGreaterThan(revealed.start);
    await tap(page, page.getByTestId("toggle"), kind);
    await expectFineUp(page);

    // A fine adjustment commits and the slider stays up.
    const before = await commits(page);
    await dragFineThumb(page, kind, 60);
    const after = await commits(page);
    expect(after.length).toBe(before.length + 1);
    await expectFineUp(page);

    // Another seek — still up, and the window follows the landing spot.
    await seekTo(page, kind, 0.05);
    await expect
      .poll(async () => (await fineBounds(page)).end)
      .toBeLessThan(revealed.end);
    await tap(page, page.getByTestId("elsewhere"), kind);
    await expectFineUp(page);
  });

  test("rows keep 44px targets and nothing overlaps or overflows", async ({ page }) => {
    await page.goto(`/player?d=${LONG}`);
    const roots = page.locator("[data-slot='slider']");
    await expect(roots).toHaveCount(2);
    const mainBox = await roots.nth(0).boundingBox();
    const fineBox = await roots.nth(1).boundingBox();
    const belowBox = await page.getByTestId("below").boundingBox();
    if (!mainBox || !fineBox || !belowBox) throw new Error("missing boxes");
    expect(mainBox.height).toBeGreaterThanOrEqual(44);
    expect(fineBox.height).toBeGreaterThanOrEqual(44);
    expect(fineBox.y + fineBox.height).toBeLessThanOrEqual(belowBox.y + 1);

    const viewport = page.viewportSize();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(viewport ? viewport.width : 390);
  });
}

test.describe("desktop mouse", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  exercise("mouse");

  test("keyboard seek also lifts fine tune, and a held drag freezes the clock", async ({
    page,
  }) => {
    await page.goto(`/player?d=${SHORT}`);
    await expectFineDown(page);
    await mainThumb(page).focus();
    await page.keyboard.press("ArrowRight");
    await expectFineUp(page);

    await page.goto(`/player?d=${LONG}`);
    await tap(page, page.getByTestId("toggle"), "mouse");
    const box = await sliderRoot(page, 0).boundingBox();
    if (!box) throw new Error("missing seek bar");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.25, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, y, { steps: 8 });
    const held = await clock(page);
    await page.waitForTimeout(400);
    expect(await clock(page)).toBe(held);
    await page.mouse.up();
    expect(await clock(page)).toBeGreaterThanOrEqual(held);
  });

  test("thirty minutes is the always-on boundary", async ({ page }) => {
    await page.goto(`/player?d=${ALWAYS}`);
    await expectFineUp(page);
    await page.goto(`/player?d=${ALWAYS - 1}`);
    await expectFineDown(page);
    await seekTo(page, "mouse", 0.5);
    await expectFineUp(page);
  });
});

test.describe("mobile touch", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  exercise("touch");
});