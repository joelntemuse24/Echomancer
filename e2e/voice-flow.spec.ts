import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

/**
 * Reproduces the owner report from the voice page: "Make audiobook" spun for
 * three minutes and ended in a raw "Failed to fetch" because no job was ever
 * created — the button was waiting on an extract that a Free-plan worker had
 * silently abandoned, and one dropped status poll failed the whole wait.
 *
 * Each test runs at both viewports: 1280x800 with a mouse and 390x844 with
 * touch, matching the desktop and phone reports.
 */

type Records = {
  requests: {
    method: string;
    url: string;
    uploadId?: string;
    nth?: number;
    body?: Record<string, unknown>;
  }[];
};

async function serverRecords(page: Page): Promise<Records> {
  const res = await page.request.get("/api/requests");
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as Records;
}

async function countRequests(
  page: Page,
  match: (r: Records["requests"][number]) => boolean
): Promise<number> {
  const { requests } = await serverRecords(page);
  return requests.filter(match).length;
}

async function configure(
  page: Page,
  uploadId: string,
  config: Record<string, unknown>
) {
  const res = await page.request.post("/api/mock-config", {
    data: { uploadId, config },
  });
  expect(res.ok()).toBeTruthy();
}

const statusPolls = (page: Page, uploadId: string) =>
  countRequests(
    page,
    (r) => r.url === "/api/pdf/upload/:id" && r.uploadId === uploadId
  );

const jobCreates = (page: Page, uploadId: string) =>
  countRequests(
    page,
    (r) => r.url === "/api/jobs" && r.uploadId === uploadId
  );

test.beforeEach(async ({ page }) => {
  // The mock API records accumulate on the shared harness server; each
  // test starts from a clean slate.
  await page.request.delete("/api/requests");
});

function flowSuite(kind: "mouse" | "touch") {
  const tapMake = (page: Page) =>
    kind === "touch"
      ? page.getByTestId("make").tap()
      : page.getByTestId("make").click();

  test("lands on the player within ~1s while extract and suggestion are still pending", async ({
    page,
  }) => {
    const uploadId = randomUUID();
    await configure(page, uploadId, {});
    await page.goto(`/voice-flow?upload=${uploadId}`);

    await expect(page.getByTestId("extract-status")).toHaveText("preparing");
    await expect(page.getByTestId("suggest")).toHaveText("Suggestion pending…");
    const historyBefore = await page.evaluate(() => history.length);

    const start = Date.now();
    await tapMake(page);
    await expect(page.getByTestId("nav")).toContainText("/dashboard/player/", {
      timeout: 3_000,
    });
    expect(Date.now() - start).toBeLessThan(1_500);

    // Replaced, not pushed: Back from the player never bounces here.
    expect(page.url()).toContain("/dashboard/player/");
    expect(await page.evaluate(() => history.length)).toBe(historyBefore);

    // The wait moved to the player; it is not an error here.
    await expect(page.getByTestId("extract-status")).toHaveText("preparing");
    await expect(page.getByTestId("start-error")).toHaveText("");

    // One POST created the book even though extract never finished.
    expect(await jobCreates(page, uploadId)).toBe(1);
  });

  test("a double tap creates exactly one book", async ({ page }) => {
    const uploadId = randomUUID();
    await configure(page, uploadId, {});
    await page.goto(`/voice-flow?upload=${uploadId}`);

    await tapMake(page);
    await expect(page.getByTestId("nav")).toContainText("/dashboard/player/");

    // The step stays spent while the player loads: the button never re-arms,
    // so the second tap is a no-op however fast it lands.
    await (kind === "touch"
      ? page.getByTestId("make").tap({ timeout: 800 })
      : page.getByTestId("make").click({ timeout: 800 })
    ).catch(() => {});
    await page.waitForTimeout(300);
    expect(await jobCreates(page, uploadId)).toBe(1);
  });

  test("rides out dead status polls without surfacing Failed to fetch", async ({
    page,
  }) => {
    const uploadId = randomUUID();
    // The first two polls die at the network level — the phone tab that
    // slept or lost signal from the owner report.
    await configure(page, uploadId, { deadPolls: 2 });
    await page.goto(`/voice-flow?upload=${uploadId}`);

    await expect
      .poll(() => statusPolls(page, uploadId), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId("extract-status")).toHaveText("preparing");
    await expect(page.getByTestId("extract-error")).toHaveText("");

    // One poller, not two: ~4 s in, the 1 s cadence has logged 4–5 reads.
    const polls = await statusPolls(page, uploadId);
    expect(polls).toBeLessThanOrEqual(6);
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  test("a finishing extract resolves the wait and feeds the create", async ({
    page,
  }) => {
    const uploadId = randomUUID();
    await configure(page, uploadId, { mode: "ready-after", readyAfter: 2 });
    await page.goto(`/voice-flow?upload=${uploadId}`);

    await expect
      .poll(() => page.getByTestId("extract-status").innerText(), {
        timeout: 10_000,
      })
      .toBe("ready");
    await expect(page.getByTestId("extract-error")).toHaveText("");

    await tapMake(page);
    await expect(page.getByTestId("nav")).toContainText("/dashboard/player/");
    const { requests } = await serverRecords(page);
    const create = requests.find(
      (r) => r.url === "/api/jobs" && r.uploadId === uploadId
    );
    expect(create?.body).toMatchObject({
      jobKind: "takehome",
      pdfStoragePath: `pdfs/${uploadId}/content.txt`,
      charCount: 4321,
    });
  });

  test("a hanging create shows a friendly error and the button recovers", async ({
    page,
  }) => {
    const uploadId = randomUUID();
    await configure(page, uploadId, { jobHang: true });
    await page.goto(
      `/voice-flow?upload=${uploadId}&createTimeout=1200`
    );

    await tapMake(page);
    await expect(page.getByTestId("start-error")).toHaveText(
      "Couldn't start. Check your connection and try again.",
      { timeout: 5_000 }
    );
    await expect(page.getByTestId("make")).toHaveText("Make audiobook");
    await expect(page.getByTestId("make")).toBeEnabled();

    // The hang clears; the same button finishes the book.
    await configure(page, uploadId, { jobHang: false });
    await tapMake(page);
    await expect(page.getByTestId("nav")).toContainText("/dashboard/player/");
    await expect(page.getByTestId("start-error")).toHaveText("");
    expect(await jobCreates(page, uploadId)).toBe(2);
  });
}

test.describe("desktop 1280x800 (mouse)", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });
  flowSuite("mouse");
});

test.describe("phone 390x844 (touch)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  flowSuite("touch");
});
