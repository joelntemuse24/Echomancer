/**
 * Shared fail-closed limiter for document intake (presign, local PUT, complete).
 */
import { createRateLimiter } from "@/lib/rate-limit";

export const uploadRateLimit = createRateLimiter(10, 60_000, {
  onError: "closed",
});
