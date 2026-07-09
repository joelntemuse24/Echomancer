/**
 * Best-effort Modal GPU warmup via the server-side /api/modal/warmup route.
 */

export async function warmupModal(
  containers: number = 2,
  purpose: "preview" | "audiobook" = "preview",
  size?: { charCount?: number; paragraphCount?: number }
): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("/api/modal/warmup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        containers: Math.min(Math.max(1, containers), 5),
        purpose,
        ...size,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      console.log(`[Warmup] ${data.status}: ${data.message}`);
    } else if (response.status === 429) {
      console.log("[Warmup] Cooldown active, skipping");
    } else {
      console.log("[Warmup] Server returned non-OK, will retry on next interaction");
    }
  } catch (e) {
    console.log("[Warmup] Failed (non-critical):", e);
  }
}