import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "@/lib/turso";
import { USER_A, buildRequest, resetDatabase } from "@/test/harness";

const USER = "user_navscreen";

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  delete process.env.ECHO_OPERATOR_TOOLS;
  delete process.env.ECHO_OPERATOR_USER_IDS;
  vi.restoreAllMocks();
});

describe("GET /api/viewer", () => {
  it("answers a signed-out session without a user-row read", async () => {
    const turso = await import("@/lib/turso");
    const queryOne = vi.spyOn(turso, "queryOne");
    const { GET } = await import("./route");

    const response = await GET(
      await buildRequest("http://localhost/api/viewer", { userId: USER_A })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({ signedIn: false, markup: false });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it("returns the signed-in name from the user row", async () => {
    await execute(
      `INSERT INTO users (id, google_sub, email, name, image, email_verified)
       VALUES (?, ?, ?, ?, NULL, 1)`,
      [USER, "sub-navscreen", "ada@example.com", "Ada"]
    );
    const { GET } = await import("./route");

    const response = await GET(
      await buildRequest("http://localhost/api/viewer", { userId: USER })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      signedIn: true,
      name: "Ada",
      email: "ada@example.com",
      markup: false,
    });
  });

  it("marks an allowlisted operator", async () => {
    process.env.ECHO_OPERATOR_TOOLS = "1";
    process.env.ECHO_OPERATOR_USER_IDS = USER;
    await execute(
      `INSERT INTO users (id, google_sub, email, name, image, email_verified)
       VALUES (?, ?, ?, ?, NULL, 1)`,
      [USER, "sub-navscreen", "ada@example.com", "Ada"]
    );
    const { GET } = await import("./route");

    const response = await GET(
      await buildRequest("http://localhost/api/viewer", { userId: USER })
    );

    expect((await response.json()).markup).toBe(true);
  });
});
