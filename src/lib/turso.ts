/**
 * Turso (LibSQL) Database Client
 * Edge-distributed SQLite for fast global access
 */
import { createClient, Client } from "@libsql/client";

// Create singleton client
let client: Client | null = null;

export function getTursoClient(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      throw new Error("TURSO_DATABASE_URL is not defined");
    }
    client = createClient({
      url,
      authToken: authToken || undefined,
    });
  }
  return client;
}

// Helper to close connection (for cleanup)
export async function closeTursoClient(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}

// Type-safe query helpers
export async function query<T = unknown>(
  sql: string,
  args?: (string | number | boolean | null)[]
): Promise<T[]> {
  const db = getTursoClient();
  const result = await db.execute({ sql, args: args || [] });
  return result.rows as T[];
}

export async function queryOne<T = unknown>(
  sql: string,
  args?: (string | number | boolean | null)[]
): Promise<T | null> {
  const rows = await query<T>(sql, args);
  return rows[0] || null;
}

export async function execute(
  sql: string,
  args?: (string | number | boolean | null)[]
): Promise<{ rowsAffected: number; lastInsertRowid: bigint | undefined }> {
  const db = getTursoClient();
  const result = await db.execute({ sql, args: args || [] });
  return {
    rowsAffected: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid,
  };
}

// Transaction helper
export async function transaction<T>(
  callback: (tx: {
    execute: typeof execute;
    query: typeof query;
    queryOne: typeof queryOne;
  }) => Promise<T>
): Promise<T> {
  const db = getTursoClient();
  const tx = await db.transaction("write");
  
  try {
    const result = await callback({
      execute: async (sql, args) => {
        const r = await tx.execute({ sql, args: args || [] });
        return {
          rowsAffected: r.rowsAffected,
          lastInsertRowid: r.lastInsertRowid,
        };
      },
      query: async <T = unknown>(sql: string, args?: (string | number | boolean | null)[]) => {
        const r = await tx.execute({ sql, args: args || [] });
        return r.rows as T[];
      },
      queryOne: async <T = unknown>(sql: string, args?: (string | number | boolean | null)[]) => {
        const r = await tx.execute({ sql, args: args || [] });
        return (r.rows as T[])[0] || null;
      },
    });
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
