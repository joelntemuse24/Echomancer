/**
 * Modal client with cold start detection
 */

const MODAL_TTS_URL = process.env.NEXT_PUBLIC_MODAL_TTS_URL || process.env.MODAL_TTS_URL;

/** Set MODAL_WARMUP_ENABLED=true to allow automatic Modal health/warmup pings. */
export function isModalWarmupEnabled(): boolean {
  return process.env.MODAL_WARMUP_ENABLED === "true";
}

interface TTSRequest {
  texts: string[];
  reference_audio_base64: string;
  nfe_step?: number;
  speed?: number;
  cfg_strength?: number;
}

interface TTSResponse {
  results: Array<{
    audio_base64: string;
    sample_rate: number;
    duration_seconds: number;
  }>;
  total_time_seconds: number;
}

export interface ModalState {
  isWarming: boolean;
  isReady: boolean;
  error: string | null;
}

/**
 * Check if Modal is warm with timeout
 */
export async function checkModalHealth(timeoutMs: number = 5000): Promise<boolean> {
  if (!isModalWarmupEnabled()) {
    return false;
  }
  if (!MODAL_TTS_URL) {
    throw new Error("MODAL_TTS_URL not configured");
  }

  const baseUrl = MODAL_TTS_URL.replace("/generate_batch", "");
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    const response = await fetch(`${baseUrl}/health`, {
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Generate audio with cold start handling
 */
export async function generateAudio(
  request: TTSRequest,
  onWarmupStart?: () => void,
  onWarmupEnd?: () => void
): Promise<TTSResponse> {
  if (!MODAL_TTS_URL) {
    throw new Error("MODAL_TTS_URL not configured");
  }

  // Check if Modal is warm
  const isWarm = await checkModalHealth(3000);
  
  if (!isWarm && onWarmupStart) {
    onWarmupStart();
  }

  try {
    const response = await fetch(MODAL_TTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`TTS request failed: ${error}`);
    }

    return await response.json();
  } finally {
    if (!isWarm && onWarmupEnd) {
      onWarmupEnd();
    }
  }
}

/**
 * Trigger Modal GPU container warmup ahead of time.
 * Calls our server-side /api/modal/warmup which then hits Modal.
 * This avoids exposing the Modal URL directly to the browser.
 * Fails silently — warmup is best-effort.
 */
export async function warmupModal(containers: number = 4): Promise<void> {
  if (!isModalWarmupEnabled()) {
    return;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout — we don't wait for Modal

    const response = await fetch("/api/modal/warmup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ containers: Math.min(Math.max(1, containers), 4) }),
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
    // Silently fail — warmup is best-effort, generation still works with cold start
    console.log("[Warmup] Failed (non-critical):", e);
  }
}

/**
 * Hook-compatible state manager
 */
export function createModalStateManager() {
  let state: ModalState = {
    isWarming: false,
    isReady: false,
    error: null,
  };

  const listeners = new Set<(state: ModalState) => void>();

  const setState = (newState: Partial<ModalState>) => {
    state = { ...state, ...newState };
    listeners.forEach((cb) => cb(state));
  };

  const subscribe = (callback: (state: ModalState) => void) => {
    listeners.add(callback);
    callback(state);
    return () => listeners.delete(callback);
  };

  const warmup = async () => {
    setState({ isWarming: true, error: null });
    
    try {
      const isReady = await checkModalHealth(90000); // 90s timeout for cold start
      setState({ isWarming: false, isReady });
      return isReady;
    } catch (error) {
      setState({ 
        isWarming: false, 
        error: error instanceof Error ? error.message : "Unknown error" 
      });
      return false;
    }
  };

  return {
    subscribe,
    warmup,
    getState: () => state,
  };
}
