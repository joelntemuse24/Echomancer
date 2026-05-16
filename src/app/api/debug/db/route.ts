import { NextResponse } from "next/server";
import { query, queryOne } from "@/lib/turso";

export async function GET() {
  try {
    const tables = await query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );

    const schema: Record<string, any> = {};
    for (const t of tables) {
      const cols = await query<{ name: string; type: string }>(
        `PRAGMA table_info(${t.name})`
      );
      schema[t.name] = cols.map((c) => ({ name: c.name, type: c.type }));
    }

    let jobsTest: any = null;
    try {
      const count = await queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM jobs"
      );
      jobsTest = { count: count?.count ?? 0 };
    } catch (e: any) {
      jobsTest = { error: e.message };
    }

    return NextResponse.json({ tables: tables.map((t) => t.name), schema, jobsTest });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message, stack: error.stack },
      { status: 500 }
    );
  }
}
