import { describe, expect, it } from "vitest";
import {
  chooseInitialExtractTarget,
  decideExtractNudge,
  EXTRACT_STUCK_MESSAGE,
  type ExtractRouteConfig,
} from "@/lib/uploads/extract-route";

const config: ExtractRouteConfig = {
  cfResendSeconds: 45,
  nodeHandoffSeconds: 75,
  uploadedNudgeSeconds: 20,
  nodeHeartbeatStaleSeconds: 180,
  nodeHardCapSeconds: 1200,
  maxAttempts: 4,
};

const NOW = 1_700_000_000;

function nudge(
  overrides: Partial<Parameters<typeof decideExtractNudge>[0]>
) {
  return decideExtractNudge(
    {
      status: "extracting",
      extractHost: "node",
      extractAttempts: 1,
      extractStartedAt: NOW - 10,
      extractAcceptedAt: NOW - 10,
      now: NOW,
      nodeConfigured: true,
      cfConfigured: true,
      ...overrides,
    },
    config
  );
}

describe("chooseInitialExtractTarget", () => {
  const base = {
    cfConfigured: true,
    nodeConfigured: true,
    production: true,
    inlineMaxBytes: 8 * 1024 * 1024,
  };

  it("sends every document to Node when the worker is configured", () => {
    for (const byteSize of [0, 20, 1_500_000, 6_000_000]) {
      expect(chooseInitialExtractTarget({ ...base, byteSize })).toBe("node");
    }
  });

  it("uses Cloudflare only when Node is not configured", () => {
    expect(
      chooseInitialExtractTarget({
        ...base,
        nodeConfigured: false,
        byteSize: 200,
      })
    ).toBe("cloudflare");
    expect(
      chooseInitialExtractTarget({
        ...base,
        nodeConfigured: false,
        byteSize: 9_000_000,
      })
    ).toBe("cloudflare");
  });

  it("extracts inline in local dev when neither host is configured", () => {
    expect(
      chooseInitialExtractTarget({
        byteSize: 9_000_000,
        cfConfigured: false,
        nodeConfigured: false,
        production: false,
        inlineMaxBytes: 8 * 1024 * 1024,
      })
    ).toBe("inline");
  });

  it("keeps the production inline ceiling when both workers are unset", () => {
    expect(
      chooseInitialExtractTarget({
        byteSize: 1000,
        cfConfigured: false,
        nodeConfigured: false,
        production: true,
        inlineMaxBytes: 8 * 1024 * 1024,
      })
    ).toBe("inline");
    expect(
      chooseInitialExtractTarget({
        byteSize: 9_000_000,
        cfConfigured: false,
        nodeConfigured: false,
        production: true,
        inlineMaxBytes: 8 * 1024 * 1024,
      })
    ).toBe("vercel");
  });
});

describe("decideExtractNudge", () => {
  it("waits while the Node child is heartbeating", () => {
    expect(nudge({ extractStartedAt: NOW - 30 }).action).toBe("wait");
  });

  it("retries Node once the heartbeat is stale", () => {
    expect(nudge({ extractStartedAt: NOW - 200, extractAttempts: 1 })).toEqual({
      action: "dispatch",
      target: "node",
    });
  });

  it("falls back to Cloudflare when Node is no longer configured", () => {
    expect(
      nudge({
        extractStartedAt: NOW - 200,
        extractAttempts: 1,
        nodeConfigured: false,
      })
    ).toEqual({ action: "dispatch", target: "cloudflare" });
  });

  it("fails a Node row after the hard cap even if the heartbeat is fresh", () => {
    expect(
      nudge({
        extractStartedAt: NOW - 5,
        extractAcceptedAt: NOW - 1200,
      })
    ).toEqual({ action: "fail", message: EXTRACT_STUCK_MESSAGE });
  });

  it("fails after the attempt cap once the current host is stale", () => {
    expect(
      nudge({
        extractAttempts: 4,
        extractStartedAt: NOW - 200,
      })
    ).toEqual({ action: "fail", message: EXTRACT_STUCK_MESSAGE });
  });

  it("hands a legacy extracting row to Node on the next poll", () => {
    expect(
      nudge({
        extractHost: null,
        extractStartedAt: NOW - 5,
        extractAttempts: 0,
      })
    ).toEqual({ action: "dispatch", target: "node" });
  });

  it("sends a legacy Cloudflare row to Vercel when Node is not configured", () => {
    expect(
      nudge({
        extractHost: null,
        extractStartedAt: NOW - 90,
        nodeConfigured: false,
        extractAttempts: 1,
      })
    ).toEqual({ action: "dispatch", target: "vercel" });
  });

  it("re-sends Cloudflare once, then returns to Node after the handoff window", () => {
    expect(
      nudge({
        extractHost: "cloudflare",
        extractAttempts: 1,
        extractStartedAt: NOW - 50,
      })
    ).toEqual({ action: "dispatch", target: "cloudflare" });
    expect(
      nudge({
        extractHost: "cloudflare",
        extractAttempts: 2,
        extractStartedAt: NOW - 80,
      })
    ).toEqual({ action: "dispatch", target: "node" });
  });

  it("does not bounce a fresh Cloudflare fallback straight back to Node", () => {
    expect(
      nudge({
        extractHost: "cloudflare",
        extractAttempts: 2,
        extractStartedAt: NOW - 5,
      }).action
    ).toBe("wait");
  });

  it("uses Vercel when a Cloudflare fallback stalls and Node is down", () => {
    expect(
      nudge({
        extractHost: "cloudflare",
        extractAttempts: 2,
        extractStartedAt: NOW - 90,
        nodeConfigured: false,
      })
    ).toEqual({ action: "dispatch", target: "vercel" });
  });

  it("fails that Cloudflare fallback once the attempt cap is spent", () => {
    expect(
      nudge({
        extractHost: "cloudflare",
        extractAttempts: 4,
        extractStartedAt: NOW - 90,
        nodeConfigured: false,
      })
    ).toEqual({ action: "fail", message: EXTRACT_STUCK_MESSAGE });
  });

  it("retries Node once, then Cloudflare, then Vercel", () => {
    expect(nudge({ extractStartedAt: NOW - 200, extractAttempts: 1 })).toEqual({
      action: "dispatch",
      target: "node",
    });
    expect(nudge({ extractStartedAt: NOW - 200, extractAttempts: 2 })).toEqual({
      action: "dispatch",
      target: "cloudflare",
    });
    expect(nudge({ extractStartedAt: NOW - 200, extractAttempts: 3 })).toEqual({
      action: "dispatch",
      target: "vercel",
    });
  });

  it("uses Vercel for a stuck uploaded row when neither worker is configured", () => {
    expect(
      nudge({
        status: "uploaded",
        extractHost: null,
        extractStartedAt: NOW - 25,
        extractAttempts: 0,
        nodeConfigured: false,
        cfConfigured: false,
      })
    ).toEqual({ action: "dispatch", target: "vercel" });
  });

  it("fails a Vercel extract that goes stale", () => {
    expect(
      nudge({
        extractHost: "inline",
        extractStartedAt: NOW - 200,
        extractAttempts: 3,
      })
    ).toEqual({ action: "fail", message: EXTRACT_STUCK_MESSAGE });
  });

  it("re-dispatches a stuck uploaded row to Node, or Cloudflare if Node is unset", () => {
    expect(
      nudge({
        status: "uploaded",
        extractHost: null,
        extractStartedAt: NOW - 25,
        extractAttempts: 0,
      })
    ).toEqual({ action: "dispatch", target: "node" });
    expect(
      nudge({
        status: "uploaded",
        extractHost: null,
        extractStartedAt: NOW - 25,
        extractAttempts: 0,
        nodeConfigured: false,
      })
    ).toEqual({ action: "dispatch", target: "cloudflare" });
  });

  it("leaves a fresh uploaded row alone", () => {
    expect(
      nudge({
        status: "uploaded",
        extractHost: null,
        extractStartedAt: NOW - 5,
      }).action
    ).toBe("wait");
  });

  it("ignores terminal rows", () => {
    expect(nudge({ status: "ready" }).action).toBe("wait");
    expect(nudge({ status: "failed" }).action).toBe("wait");
  });
});
