import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "@/lib/turso";
import { resetDatabase } from "@/test/harness";
import {
  isMarkupOperator,
  operatorToolsEnabled,
} from "@/lib/operator/tools";

const OPERATOR_ID = "user_" + "c".repeat(32);
const OWNER_ID = "user_" + "d".repeat(32);

async function seedUser(id: string, email: string, verified = 1) {
  await execute(
    `INSERT INTO users (id, google_sub, email, name, email_verified) VALUES (?, ?, ?, ?, ?)`,
    [id, `sub-${id}`, email, "Test", verified]
  );
}

beforeEach(async () => {
  await resetDatabase();
  delete process.env.ECHO_OPERATOR_TOOLS;
  delete process.env.ECHO_OPERATOR_EMAILS;
  delete process.env.ECHO_OPERATOR_USER_IDS;
});

afterEach(() => {
  delete process.env.ECHO_OPERATOR_TOOLS;
  delete process.env.ECHO_OPERATOR_EMAILS;
  delete process.env.ECHO_OPERATOR_USER_IDS;
});

describe("isMarkupOperator", () => {
  it("matches a verified Google email and ignores an unverified one", async () => {
    await seedUser(OPERATOR_ID, "Operator@Example.com", 1);
    process.env.ECHO_OPERATOR_EMAILS = " operator@example.com , other@example.com ";
    expect(await isMarkupOperator(OPERATOR_ID)).toBe(true);

    await execute(`UPDATE users SET email_verified = 0 WHERE id = ?`, [
      OPERATOR_ID,
    ]);
    expect(await isMarkupOperator(OPERATOR_ID)).toBe(false);
  });

  it("rejects a signed-in account that is not on the list", async () => {
    await seedUser(OWNER_ID, "reader@example.com");
    process.env.ECHO_OPERATOR_EMAILS = "operator@example.com";

    expect(await isMarkupOperator(OWNER_ID)).toBe(false);
    expect(await isMarkupOperator("anon_" + "a".repeat(32))).toBe(false);
    expect(await isMarkupOperator(null)).toBe(false);
  });

  it("rejects everyone when the allowlist is empty", async () => {
    await seedUser(OPERATOR_ID, "operator@example.com");
    expect(await isMarkupOperator(OPERATOR_ID)).toBe(false);
  });

  it("matches a durable user id without consulting email", async () => {
    process.env.ECHO_OPERATOR_USER_IDS = `${OPERATOR_ID}, user_other`;
    expect(await isMarkupOperator(OPERATOR_ID)).toBe(true);
    expect(await isMarkupOperator(OWNER_ID)).toBe(false);
  });

  it("stays closed in production until the master switch is on", async () => {
    const previousNode = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.ECHO_OPERATOR_EMAILS = "operator@example.com";
    await seedUser(OPERATOR_ID, "operator@example.com");
    try {
      expect(operatorToolsEnabled()).toBe(false);
      expect(await isMarkupOperator(OPERATOR_ID)).toBe(false);
      process.env.ECHO_OPERATOR_TOOLS = "1";
      expect(await isMarkupOperator(OPERATOR_ID)).toBe(true);
      process.env.ECHO_OPERATOR_TOOLS = "0";
      expect(operatorToolsEnabled()).toBe(false);
      expect(await isMarkupOperator(OPERATOR_ID)).toBe(false);
    } finally {
      process.env.NODE_ENV = previousNode;
    }
  });
});
