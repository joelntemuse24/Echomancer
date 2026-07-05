import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const diagnostics: Record<string, string> = {};

  // Check which env vars are present (not empty)
  const vars = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "MODAL_TTS_URL",
    "MODAL_MOSS_TTS_URL",
    "MODAL_MOSS_LOCAL_TTS_URL",
    "MODAL_MOSS_DELAY_TTS_URL",
    "MODAL_MOSS_API_TTS_URL",
    "MOSS_AB_VARIANT",
    "TTS_PIPELINE_MODE",
    "MOSS_TTS_LANGUAGE",
    "TURSO_DATABASE_URL",
    "TURSO_AUTH_TOKEN",
    "WEBHOOK_SECRET",
    "NEXT_PUBLIC_APP_URL",
    "STORAGE_PATH",
  ];

  for (const v of vars) {
    const val = process.env[v];
    diagnostics[v] = val
      ? `present (${val.length} chars, starts with "${val.slice(0, 4)}")`
      : "MISSING or empty";
  }

  // Build the R2 endpoint to verify it looks correct
  const accountId = process.env.R2_ACCOUNT_ID;
  diagnostics["R2_ENDPOINT"] = accountId
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : "cannot build — R2_ACCOUNT_ID missing";

  // Check if endpoint resolves (DNS)
  try {
    const { lookup } = await import("dns");
    await new Promise<void>((resolve, reject) => {
      if (!accountId) return reject(new Error("No account ID"));
      lookup(`${accountId}.r2.cloudflarestorage.com`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    diagnostics["R2_DNS"] = "OK — endpoint resolves";
  } catch (err: any) {
    diagnostics["R2_DNS"] = `FAILED — ${err?.message || String(err)}`;
  }

  return NextResponse.json({ diagnostics });
}
