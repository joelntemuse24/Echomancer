import { describe, expect, it } from "vitest";
import { omitRemovedJobs } from "./omit-removed-jobs";

describe("omitRemovedJobs", () => {
  const jobs = [
    { id: "kept", title: "Kept" },
    { id: "gone", title: "Gone" },
  ];

  it("returns the list unchanged when nothing was deleted", () => {
    expect(omitRemovedJobs(jobs, new Set())).toBe(jobs);
  });

  it("drops a book a successful delete already removed, even if a poll still returns it", () => {
    expect(omitRemovedJobs(jobs, new Set(["gone"]))).toEqual([
      { id: "kept", title: "Kept" },
    ]);
  });
});