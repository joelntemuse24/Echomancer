/**
 * Cookie-free bytes for one signed clone preview.
 *
 * Ownership was checked when the voices list minted the token. This handler
 * checks the signature, then streams the object. It does not read the
 * session, so the response can be cached at the edge.
 */

import { NextRequest } from "next/server";
import { verifyClonePreviewMediaToken } from "@/lib/tts/clone-preview-media";
import { clonePreviewStreamResponse } from "@/lib/tts/clone-preview-stream";

export const runtime = "nodejs";

const MISS = {
  "Cache-Control": "private, no-store",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
} as const;

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  const startedAt = performance.now();
  const { token } = await ctx.params;
  let storagePath: string | null = null;
  try {
    storagePath = verifyClonePreviewMediaToken(decodeURIComponent(token));
  } catch {
    storagePath = null;
  }
  if (!storagePath) {
    return new Response(null, { status: 404, headers: MISS });
  }
  try {
    const streamed = await clonePreviewStreamResponse(request, storagePath, {
      cache: "public",
      resolve: "stored",
      startedAt,
    });
    if (!streamed) return new Response(null, { status: 404, headers: MISS });
    return streamed;
  } catch (err) {
    console.warn(
      "[clone-preview] media read failed",
      err instanceof Error ? err.name : "error"
    );
    return new Response(null, {
      status: 503,
      headers: {
        ...MISS,
        "Server-Timing": `total;dur=${(performance.now() - startedAt).toFixed(1)}`,
      },
    });
  }
}
