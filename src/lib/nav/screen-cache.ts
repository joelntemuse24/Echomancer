/**
 * Browser cache for the screens people move between.
 *
 * Library, Voices, and the player are client pages. They used to mount,
 * show a spinner, and wait on `/api/jobs` or `/api/tts/voices` every time,
 * including the trip back. This keeps the last payload for the tab and
 * dedupes the request a warm-up and a page start at the same moment.
 *
 * The map lives in the browser only. Server rendering always sees a miss,
 * so one visitor's library cannot be written into another visitor's HTML.
 */

export const SCREEN_JOBS = "jobs";
export const SCREEN_VOICES = "voices";

/** A bounce between screens inside this window does not hit the network again. */
export const SCREEN_FRESH_MS = 20_000;

type Entry = { value: unknown; at: number };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

export function screenJobKey(id: string): string {
  return `job:${id}`;
}

/**
 * The server render of a client page shares a module graph across requests.
 * A hit there could paint one person's library into someone else's HTML.
 * Unit tests run in Node without `window` and are the exception.
 */
function serverRender(): boolean {
  return typeof window === "undefined" && process.env.VITEST !== "true";
}

export function peekScreen<T>(key: string): T | null {
  if (serverRender()) return null;
  const hit = store.get(key);
  return hit ? (hit.value as T) : null;
}

export function putScreen(key: string, value: unknown, at = Date.now()): void {
  if (serverRender()) return;
  store.set(key, { value, at });
}

export function peekJob<T>(id: string): T | null {
  const hit = peekScreen<{ job?: T }>(screenJobKey(id));
  return hit?.job ?? null;
}

type JobSummary = { id?: string; chapters?: unknown };

/**
 * Remember the library payload and seed each book so opening the player
 * can paint the title from the row the list already fetched.
 * A detail payload that already carries chapters wins over a later summary.
 */
export function rememberJobsList(body: { jobs?: JobSummary[] | null }): void {
  putScreen(SCREEN_JOBS, body);
  for (const job of body.jobs ?? []) {
    if (!job || typeof job.id !== "string" || !job.id) continue;
    const key = screenJobKey(job.id);
    const existing = peekScreen<{ job?: JobSummary }>(key);
    if (Array.isArray(existing?.job?.chapters)) continue;
    putScreen(key, { job });
  }
}

export function rememberJobDetail(id: string, body: { job: unknown }): void {
  putScreen(screenJobKey(id), body);
}

export function loadScreen<T>(
  key: string,
  url: string,
  opts?: { force?: boolean; freshMs?: number }
): Promise<T> {
  const freshMs = opts?.freshMs ?? SCREEN_FRESH_MS;
  const hit = serverRender() ? undefined : store.get(key);
  if (hit && !opts?.force && Date.now() - hit.at < freshMs) {
    return Promise.resolve(hit.value as T);
  }
  let pending = inflight.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = fetch(url, { headers: { accept: "application/json" } }).then(
      async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as T;
        if (key === SCREEN_JOBS) rememberJobsList(data as { jobs?: JobSummary[] });
        else putScreen(key, data);
        return data;
      }
    );
    const tracked = pending.finally(() => {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
    pending = tracked;
    inflight.set(key, tracked);
  }
  return pending;
}

export function warmScreen(key: string, url: string): void {
  void loadScreen(key, url).catch(() => {});
}

/** Jobs, voices, and nothing else. Called once from the root shell. */
export function warmAppScreens(): void {
  warmScreen(SCREEN_JOBS, "/api/jobs");
  warmScreen(SCREEN_VOICES, "/api/tts/voices");
}

export function resetScreenCache(): void {
  store.clear();
  inflight.clear();
}
