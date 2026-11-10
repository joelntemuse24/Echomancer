import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "@/lib/turso";
import { USER_A, buildRequest, resetDatabase } from "@/test/harness";

const USER = "user_navscreen";

const userLookup = vi.hoisted(() => ({
  impl: null as null | ((id: string) => Promise<unknown>),
}));

vi.mock("@/lib/auth/google", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/google")>();
  return {
    ...actual,
    getUserById: (id: string) =>
      userLookup.impl ? userLookup.impl(id) : actual.getUserById(id),
  };
});

beforeEach(async () => {
  userLookup.impl = null;
  await resetDatabase();
});

afterEach(() => {
  delete process.env.ECHO_OPERATOR_TOOLS;
  delete process.env.ECHO_OPERATOR_USER_IDS;
  userLookup.impl = null;
});

describe("GET /api/viewer", () => {
  it("answers a signed-out session without a user-row read", async () => {
    const reads = vi.fn();
    userLookup.impl = async (id) => {
      reads(id);
      return null;
    };
    const { GET } = await import("./route");

    const response = await GET(
      await buildRequest("http://localhost/api/viewer", { userId: USER_A })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({ signedIn: false, markup: false });
    expect(body.key).toMatch(/^[0-9a-f]{16}$/);
    expect(body.key).not.toBe(USER_A);
    expect(reads).not.toHaveBeenCalled();
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
    expect(body.key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("stays signed in when the user row is missing", async () => {
    userLookup.impl = async () => null;
    const { GET } = await import("./route");

    const response = await GET(
      await buildRequest("http://localhost/api/viewer", { userId: USER })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      signedIn: true,
      name: null,
      email: null,
      image: null,
      markup: false,
    });
  });

  it("does not cache a database error as signed out", async () => {
    userLookup.impl = async () => {
      throw new Error("turso down");
    };
    const { GET } = await import("./route");

    const response = await GET(
      await buildRequest("http://localhost/api/viewer", { userId: USER })
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.signedIn).toBeUndefined();
    expect(body.error).toBeTruthy();
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

  it("keeps markup for an allowlisted anonymous id", async () => {
    process.env.ECHO_OPERATOR_TOOLS = "1";
    process.env.ECHO_OPERATOR_USER_IDS = USER_A;
    const reads = vi.fn();
    userLookup.impl = async (id) => {
      reads(id);
      return null;
    };
    const { GET } = await import("./route");

    const response = await GET(
      await buildRequest("http://localhost/api/viewer", { userId: USER_A })
    );
    const body = await response.json();

    expect(body).toMatchObject({ signedIn: false, markup: true });
    expect(reads).not.toHaveBeenCalled();
  });
});
