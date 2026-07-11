import { execute, query } from "@/lib/turso";

let routingColumnsReady: Promise<void> | null = null;
let voiceColumnsReady: Promise<void> | null = null;

/**
 * Additive migration for existing production databases. SQLite does not
 * support ADD COLUMN IF NOT EXISTS, so inspect the table before altering it.
 */
export async function ensureJobRoutingColumns(): Promise<void> {
  if (!routingColumnsReady) {
    routingColumnsReady = (async () => {
      const columns = await query<{ name: string }>("PRAGMA table_info(jobs)");
      const names = new Set(columns.map((column) => column.name));
      const additions = [
        ["tts_variant", "TEXT"],
        ["char_count", "INTEGER"],
        ["paragraph_count", "INTEGER"],
        ["voice_clips", "TEXT"],
        ["style_selection_seed", "INTEGER"],
        ["synthesis_contract", "TEXT"],
      ] as const;

      for (const [name, type] of additions) {
        if (!names.has(name)) {
          try {
            await execute(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
          } catch (error) {
            // Another serverless instance may have completed the same migration.
            if (
              !(error instanceof Error) ||
              !error.message.toLowerCase().includes("duplicate column")
            ) {
              throw error;
            }
          }
        }
      }

      // All jobs created before variant tracking used the production SGLang
      // route. Backfill them so Delay generations never dedupe to old audio.
      await execute(
        `UPDATE jobs SET tts_variant = 'sglang' WHERE tts_variant IS NULL`
      );
    })().catch((error) => {
      routingColumnsReady = null;
      throw error;
    });
  }

  return routingColumnsReady;
}

export async function ensureVoiceStyleColumns(): Promise<void> {
  if (!voiceColumnsReady) {
    voiceColumnsReady = (async () => {
      const columns = await query<{ name: string }>("PRAGMA table_info(voices)");
      const names = new Set(columns.map((column) => column.name));
      if (!names.has("voice_clips")) {
        try {
          await execute(`ALTER TABLE voices ADD COLUMN voice_clips TEXT`);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.toLowerCase().includes("duplicate column")
          ) {
            throw error;
          }
        }
      }
    })().catch((error) => {
      voiceColumnsReady = null;
      throw error;
    });
  }
  return voiceColumnsReady;
}
