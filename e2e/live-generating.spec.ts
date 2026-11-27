import { expect, test } from "@playwright/test";
import { startLiveGeneratingServer } from "./live-generating-server";

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
