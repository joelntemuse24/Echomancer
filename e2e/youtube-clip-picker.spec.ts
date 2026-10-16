import { expect, test } from "@playwright/test";

// Parent harness integration serves youtube-clip-picker-harness.tsx at this route.
test("timestamp fallback, editable clocks, and explicit playback", async ({ page }) => {
  await page.goto("/youtube-clip-picker");
  await page.getByRole("textbox", { name: "YouTube link or search" }).fill("https://youtu.be/abcdefghijk?t=1h2m3s");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Start time", exact: true })).toHaveValue("1:02:03");
  await expect(page.getByRole("link", { name: "Open this moment on YouTube" })).toHaveAttribute("href", /t=3723s$/);
  await expect(page.locator("#picker-stats")).toContainText("0 plays");
  await page.getByRole("textbox", { name: "End time", exact: true }).fill("1:02:33");
  await page.getByRole("textbox", { name: "End time", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Play selection", exact: true }).click();
  await expect(page.locator("#picker-stats")).toContainText("1 plays");
  await page.getByRole("textbox", { name: "End time", exact: true }).fill("1:05:00");
  await page.getByRole("textbox", { name: "End time", exact: true }).press("Enter");
  await expect(page.getByRole("alert")).toContainText("between 10 and 40 seconds");
  await expect(page.getByRole("button", { name: "Use this clip", exact: true })).toBeDisabled();
});

test("a drag seeks once when released without starting playback", async ({ page }) => {
  await page.goto("/youtube-clip-picker");
  await page.getByRole("textbox", { name: "YouTube link or search" }).fill("https://youtu.be/abcdefghijk?t=45s");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const start = page.getByRole("slider", { name: "Start", exact: true });
  await expect(start).toBeVisible();
  await expect(page.locator("#picker-stats")).toContainText("1 seeks");
  const box = await start.boundingBox();
  if (!box) throw new Error("Missing start handle");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 15, box.y + box.height / 2, { steps: 8 });
  await expect(page.locator("#picker-stats")).toContainText("1 seeks");
  await page.mouse.up();
  await expect(page.locator("#picker-stats")).toHaveText("2 seeks; 0 plays");
});

test("recovers an owner-scoped clip and queues risk acceptance", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echomancer.pending-youtube-clip", JSON.stringify({
    id: "clip-recovery", ownerContext: "owner-a", startedAt: Date.now(),
  })));
  await page.goto("/youtube-clip-picker");
  await expect(page.getByText("Room echo", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue anyway" }).click();
  await expect(page.getByText("This clip may not clone well.", { exact: true })).toHaveCount(0);
});