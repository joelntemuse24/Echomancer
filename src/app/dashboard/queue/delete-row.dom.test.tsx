/**
 * @vitest-environment jsdom
 *
 * A successful delete removes the row. A library poll that still has the
 * book (it started before the row was soft-deleted) must not put it back.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetScreenCache } from "@/lib/nav/screen-cache";
import QueuePage from "./page";

const JOB_ID = "7c1bcf22-0000-4000-8000-000000000293";

function book() {
  return {
    id: JOB_ID,
    book_title: "Harbor Lights",
    voice_name: "Drew",
    status: "ready" as const,
    progress: 100,
    current_section: 1,
    total_sections: 1,
    duration_seconds: 60,
    error_message: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    job_kind: "takehome",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("library delete", () => {
  let listed: ReturnType<typeof book>[];
  let deleteStatus: number;

  beforeEach(() => {
    resetScreenCache();
    listed = [book()];
    deleteStatus = 200;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "DELETE") return json({ success: true, message: "Job deleted" }, deleteStatus);
        if (url.includes("/api/jobs")) return json({ jobs: listed });
        return json({});
      })
    );
  });

  afterEach(() => {
    cleanup();
    resetScreenCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("removes the row on success and keeps it gone when a stale poll returns it", async () => {
    render(<QueuePage />);
    const button = await screen.findByRole("button", { name: "Delete Harbor Lights" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Delete Harbor Lights" })).toBeNull();
    });
    expect(screen.queryByText("Harbor Lights")).toBeNull();

    listed = [book()];
    const libraryGets = () =>
      vi.mocked(fetch).mock.calls.filter(([url, init]) => {
        const method = (init as RequestInit | undefined)?.method;
        return String(url).includes("/api/jobs") && method !== "DELETE";
      }).length;
    const getsBefore = libraryGets();
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(libraryGets()).toBeGreaterThan(getsBefore);
    });
    expect(screen.queryByText("Harbor Lights")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Harbor Lights" })).toBeNull();
  });

  it("leaves the row in place when delete fails", async () => {
    deleteStatus = 500;
    render(<QueuePage />);
    const button = await screen.findByRole("button", { name: "Delete Harbor Lights" });
    fireEvent.click(button);

    expect((await screen.findByRole("status")).textContent).toContain(
      "Couldn't delete. Try again."
    );
    expect(screen.getByRole("button", { name: "Delete Harbor Lights" })).toBeTruthy();
  });
});
