/**
 * One-shot process for the capacity tests. Environment is set before any
 * app import so this process gets its own database connection.
 *
 *   tsx src/lib/jobs/capacity-child.ts slot <file-url> <owner> <provider> <cap>
 *   tsx src/lib/jobs/capacity-child.ts create <file-url> <jobId>
 */

const mode = process.argv[2];
const url = process.argv[3];

if (!mode || !url) {
  console.log(JSON.stringify({ error: "missing args" }));
  process.exit(1);
}

const databaseUrl: string = url;
process.env.TURSO_DATABASE_URL = databaseUrl;
process.env.VITEST = "1";

async function main(): Promise<void> {
  if (mode === "slot") {
    const owner = process.argv[4] || "owner";
    const provider = process.argv[5] || "modal-clone";
    const cap = Number(process.argv[6] || "1");
    const { createClient } = await import("@libsql/client");
    const { tryAcquireProviderSlot } = await import("@/lib/tts/provider-slots");
    const client = createClient({ url: databaseUrl });
    await client.execute("PRAGMA busy_timeout = 5000");
    const db = {
      execute: async (sql: string, args?: (string | number | null)[]) => {
        const result = await client.execute({ sql, args: args ?? [] });
        return { rowsAffected: result.rowsAffected };
      },
      queryOne: async <T>(sql: string, args?: (string | number | null)[]) => {
        const result = await client.execute({ sql, args: args ?? [] });
        return (result.rows[0] as T) ?? null;
      },
    };
    const slot = await tryAcquireProviderSlot(db, {
      provider,
      cap,
      ownerToken: owner,
      ttlSeconds: 90,
    });
    console.log(JSON.stringify({ slot }));
    client.close();
    return;
  }

  if (mode === "migrate") {
    const { ensureTtsJobColumns } = await import("@/lib/tts/schema-migrate");
    const { ensureProviderSlotTable } = await import("@/lib/tts/provider-slots");
    const { execute, closeTursoClient } = await import("@/lib/turso");
    await execute("PRAGMA busy_timeout = 5000");
    await ensureTtsJobColumns();
    await ensureProviderSlotTable();
    console.log(JSON.stringify({ ok: true }));
    await closeTursoClient();
    return;
  }

  if (mode === "create") {
    const jobId = process.argv[4];
    if (!jobId) {
      console.log(JSON.stringify({ error: "missing job id" }));
      return;
    }
    const { ensureTtsJobColumns } = await import("@/lib/tts/schema-migrate");
    const { beginTakehomeCreate, commitTakehomeCreate, TakehomeCreateBusyError } =
      await import("@/lib/jobs/takehome-identity");
    const { execute, closeTursoClient } = await import("@/lib/turso");
    await execute("PRAGMA busy_timeout = 5000");
    await ensureTtsJobColumns();
    try {
      const opened = await beginTakehomeCreate({
        userId: "user_proc",
        pdfStoragePath: "pdfs/race/content.txt",
        ttsProvider: "edge",
        catalogVoiceId: "standard",
        providerVoiceId: "en-US-AndrewNeural",
        jobId,
      });
      if (opened.action === "insert") {
        await execute(
          `INSERT INTO jobs (
             id, user_id, book_title, voice_name, status, progress, pdf_storage_path,
             generation_mode, job_kind, tts_provider, provider_voice_id,
             catalog_voice_id, char_count, next_section_index
           ) VALUES (?, ?, ?, ?, 'queued', 0, ?, 'stock', 'takehome', ?, ?, ?, 20, 0)`,
          [
            jobId,
            "user_proc",
            "Race",
            "Andrew",
            "pdfs/race/content.txt",
            "edge",
            "en-US-AndrewNeural",
            "standard",
          ]
        );
        await commitTakehomeCreate(opened.idemKey, jobId);
      }
      console.log(JSON.stringify(opened));
    } catch (err) {
      const name = err instanceof TakehomeCreateBusyError ? "TakehomeCreateBusyError" : "error";
      console.log(
        JSON.stringify({
          error: name,
          message: err instanceof Error ? err.message : String(err),
        })
      );
    } finally {
      await closeTursoClient();
    }
    return;
  }

  console.log(JSON.stringify({ error: `unknown mode ${mode}` }));
}

main().catch((err) => {
  console.log(
    JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  );
  process.exit(1);
});
