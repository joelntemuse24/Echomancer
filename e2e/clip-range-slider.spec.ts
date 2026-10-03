import { expect, test, type Locator, type Page } from "@playwright/test";

type PointerKind = "mouse" | "touch";

async function settle(page: Page) {
  const start = page.getByRole("slider", { name: "Start" });
  await start.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    document.querySelector("[role='slider']")?.scrollIntoView({ block: "center", inline: "nearest" });
  });
  await expect(start).toBeVisible();
  return start;
}

async function values(page: Page) {
  const start = page.getByRole("slider", { name: "Start" });
  const end = page.getByRole("slider", { name: "End" });
  const startSec = Number(await start.getAttribute("aria-valuenow"));
  const endSec = Number(await end.getAttribute("aria-valuenow"));
  const request = (await page.getByTestId("request").innerText()).trim();
  const label = (await page.getByTestId("label").innerText()).trim();
  return { start, end, startSec, endSec, request, label };
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("missing slider handle");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, kind: PointerKind) {
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
  if (!box) throw new Error("missing fine control");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (kind === "mouse") {
    await page.mouse.click(x, y);
    return;
  }
  await page.touchscreen.tap(x, y);
}

function exercise(kind: PointerKind) {
  test("both handles stay grabbable and the posted window matches the label", async ({ page }) => {
    await page.goto("/?d=7200&start=45&end=65");
    await settle(page);
    const before = await values(page);
    expect(before.endSec - before.startSec).toBe(20);
    expect(before.request).toBe(`${before.startSec}+${before.endSec - before.startSec}`);

    const startBox = await center(before.start);
    const endBox = await center(before.end);
    expect(endBox.x - startBox.x).toBeGreaterThanOrEqual(44);
    expect(startBox.box.width).toBeGreaterThanOrEqual(44);
    expect(startBox.box.height).toBeGreaterThanOrEqual(44);

    const scrollBefore = await page.evaluate(() => window.scrollY);
    await drag(page, startBox, { x: startBox.x - 80, y: startBox.y }, kind);
    await expect.poll(async () => (await values(page)).startSec).toBeLessThan(before.startSec);
    const nudged = await values(page);
    expect(nudged.endSec).toBe(before.endSec);
    expect(nudged.endSec - nudged.startSec).toBeGreaterThanOrEqual(10);
    expect(nudged.request).toBe(`${nudged.startSec}+${nudged.endSec - nudged.startSec}`);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

    const endNow = await center(nudged.end);
    await drag(page, endNow, { x: endNow.x + 280, y: endNow.y }, kind);
    const capped = await values(page);
    expect(capped.startSec).toBe(nudged.startSec);
    expect(capped.endSec - capped.startSec).toBe(40);
    expect(capped.request).toBe(`${capped.startSec}+40`);

    const startFar = await center(page.getByRole("slider", { name: "Start" }));
    const endFar = await center(page.getByRole("slider", { name: "End" }));
    await drag(page, startFar, { x: endFar.x + 120, y: startFar.y }, kind);
    const held = await values(page);
    expect(held.endSec).toBe(capped.endSec);
    expect(held.endSec - held.startSec).toBeGreaterThanOrEqual(10);
    expect(held.endSec).toBeGreaterThan(held.startSec);

    const windowStart = await center(page.getByRole("slider", { name: "Start" }));
    const windowEnd = await center(page.getByRole("slider", { name: "End" }));
    const mid = { x: (windowStart.x + windowEnd.x) / 2, y: windowStart.y };
    const length = held.endSec - held.startSec;
    await drag(page, mid, { x: mid.x - 64, y: mid.y }, kind);
    const moved = await values(page);
    expect(moved.endSec - moved.startSec).toBe(length);
    expect(moved.startSec).toBeLessThan(held.startSec);
    expect(moved.request).toBe(`${moved.startSec}+${moved.endSec - moved.startSec}`);
    expect(moved.label).toContain("(40s max)");
  });

  test("fine tune stays up and steps one edge by one second", async ({ page }) => {
    await page.goto("/?d=7200&start=45&end=65");
    await settle(page);
    const earlier = page.getByRole("button", { name: "Start earlier" });
    const later = page.getByRole("button", { name: "End later" });
    await expect(earlier).toBeVisible();
    await expect(page.getByText("Fine tune", { exact: true })).toBeVisible();
    const box = await earlier.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);

    const before = await values(page);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await tap(page, earlier, kind);
    await expect.poll(async () => (await values(page)).startSec).toBe(before.startSec - 1);
    const stepped = await values(page);
    expect(stepped.endSec).toBe(before.endSec);
    expect(stepped.request).toBe(`${stepped.startSec}+${stepped.endSec - stepped.startSec}`);
    expect(stepped.label).toContain("0:44");
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await expect(earlier).toBeVisible();

    await tap(page, later, kind);
    const both = await values(page);
    expect(both).toMatchObject({
      startSec: before.startSec - 1,
      endSec: before.endSec + 1,
      request: `${before.startSec - 1}+${before.endSec + 1 - (before.startSec - 1)}`,
    });
    await expect(later).toBeVisible();
  });

  test("fine tune stops at the video and at 40 seconds", async ({ page }) => {
    await page.goto("/?d=600&start=560&end=600");
    await settle(page);
    await expect(page.getByRole("button", { name: "End later" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Start earlier" })).toBeDisabled();
    const before = await values(page);
    expect(before.request).toBe("560+40");
    await tap(page, page.getByRole("button", { name: "Start later" }), kind);
    const after = await values(page);
    expect(after).toMatchObject({ startSec: 561, endSec: 600, request: "561+39" });
    expect(after.label).toContain("10:00");
  });

  test("a window at the end of the video cannot be dragged past it", async ({ page }) => {
    await page.goto("/?d=600&start=560&end=600");
    await settle(page);
    const before = await values(page);
    expect(before.request).toBe("560+40");
    const end = await center(before.end);
    await drag(page, end, { x: end.x + 160, y: end.y }, kind);
    const after = await values(page);
    expect(after.endSec).toBe(600);
    expect(after.startSec).toBe(560);
    expect(after.request).toBe("560+40");

    const start = await center(page.getByRole("slider", { name: "Start" }));
    expect(start.box.x).toBeGreaterThanOrEqual(0);
    expect(start.box.width).toBeGreaterThanOrEqual(44);
  });
}

test.describe("desktop mouse", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  exercise("mouse");

  test("arrow keys move the focused edge and leave the other one", async ({ page }) => {
    await page.goto("/?d=7200&start=45&end=65");
    await settle(page);
    await page.getByRole("slider", { name: "Start" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await values(page)).startSec).toBe(44);
    expect((await values(page)).endSec).toBe(65);
    await page.getByRole("slider", { name: "End" }).focus();
    await page.keyboard.press("ArrowRight");
    const after = await values(page);
    expect(after).toMatchObject({ startSec: 44, endSec: 66, request: "44+22" });
    await page.getByRole("button", { name: "Start earlier" }).focus();
    await page.keyboard.press("Enter");
    expect(await values(page)).toMatchObject({ startSec: 43, endSec: 66, request: "43+23" });
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
