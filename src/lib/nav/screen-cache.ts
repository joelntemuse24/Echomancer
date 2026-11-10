/**
 * Browser cache for the screens people move between.
 *
 * Library and Voices paint from the last payload, then revalidate. The
 * freshness window only skips a second warmup while one request is already
 * in flight or just finished. A page mount always asks again, so a book
 * created a moment ago cannot stay missing for the rest of the tab.
 *
 * The map lives in the browser only. Server rendering always sees a miss,
 * so one visitor's library cannot be written into another visitor's HTML.
 */

export const SCREEN_JOBS = "jobs";
export const SCREEN_VOICES = "voices";

/** A warmup inside this window does not start another request. */
export const SCREEN_FRESH_MS = 20_000;

const JOBS_URL = "/api/jobs";
const VOICES_URL = "/api/tts/voices";

type Entry = { value: unknown; at: number };
type Flight = { promise: Promise<unknown>; generation: number };

const store = new Map<string, Entry>();
const inflight = new Map<string, Flight>();
const resetListeners = new Set<() => void>();
let generation = 0;

export function screenJobKey(id: string): string {
  return `job:${id}`;
}

/**
 * The server render of a client page shares a module graph across requests.
 * A hit there could paint one person's library into someone else's HTML.
 * Unit tests run in Node without `window` and are the exception.
 */
function serverRender(): boolean {
  if (typeof window === "undefined" && process.env.VITEST !== "true") return true;
  return false;
}

export function peekScreen<T>(key: string): T | null {
  if (serverRender()) return null;
  const hit = store.get(key);
  return hit ? (hit.value as T) : null;
}

export function screenCachedAt(key: string): number | null {
  if (serverRender()) return null;
  return store.get(key)?.at ?? null;
}

export function putScreen(key: string, value: unknown, at = Date.now()): void {
  if (serverRender()) return;
  store.set(key, { value, at });
}

/** Replace the payload and keep the timestamp a network response set. */
export function replaceScreenValue(key: string, value: unknown): void {
  if (serverRender()) return;
  const existing = store.get(key);
  store.set(key, { value, at: existing?.at ?? 0 });
}

export function peekJob<T>(id: string): T | null {
  const hit = peekScreen<{ job?: T }>(screenJobKey(id));
  return hit?.job ?? null;
}

export function forgetJob(id: string): void {
  if (serverRender()) return;
  store.delete(screenJobKey(id));
}

type JobSummary = { id?: string; chapters?: unknown };

/**
 * Remember the library payload and seed each book so opening the player
 * can paint the title from the row the list already fetched.
 * A detail payload that already carries chapters wins over a later summary.
 * Local edits pass `stamp: false` so they do not pretend a fetch just happened.
 * A network list passes `prune: true` and drops books that are gone.
 */
export function rememberJobsList(
  body: { jobs?: JobSummary[] | null },
  opts?: { stamp?: boolean; prune?: boolean }
): void {
  if (serverRender()) return;
  const existing = store.get(SCREEN_JOBS);
  const at = opts?.stamp ? Date.now() : (existing?.at ?? 0);
  store.set(SCREEN_JOBS, { value: body, at });
  const ids = new Set<string>();
  for (const job of body.jobs ?? []) {
    if (!job || typeof job.id !== "string" || !job.id) continue;
    ids.add(job.id);
    const key = screenJobKey(job.id);
    const prev = store.get(key);
    const prevJob = (prev?.value as { job?: JobSummary } | undefined)?.job;
    if (Array.isArray(prevJob?.chapters)) continue;
    store.set(key, { value: { job }, at: prev?.at ?? at });
  }
  if (!opts?.prune) return;
  for (const key of store.keys()) {
    if (!key.startsWith("job:")) continue;
    if (!ids.has(key.slice(4))) store.delete(key);
  }
}

export function rememberJobDetail(id: string, body: { job: unknown }): void {
  putScreen(screenJobKey(id), body);
}

export function loadScreen<T>(
  key: string,
  url: string,
  opts?: { warm?: boolean }
): Promise<T> {
  const gen = generation;
  const hit = serverRender() ? undefined : store.get(key);
  if (opts?.warm && hit && Date.now() - hit.at < SCREEN_FRESH_MS) {
    return Promise.resolve(hit.value as T);
  }
  const pending = inflight.get(key);
  if (pending && pending.generation === gen) {
    return pending.promise as Promise<T>;
  }
  const promise = fetch(url, { headers: { accept: "application/json" } }).then(
    async (response) => {
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as T;
      if (generation !== gen) return loadScreen<T>(key, url);
      if (serverRender()) return data;
      if (key === SCREEN_JOBS) {
        rememberJobsList(data as { jobs?: JobSummary[] }, { stamp: true, prune: true });
      } else {
        putScreen(key, data);
      }
      return data;
    }
  );
  const tracked = promise.finally(() => {
    if (inflight.get(key)?.promise === tracked) inflight.delete(key);
  });
  inflight.set(key, { promise: tracked, generation: gen });
  return tracked;
}

export function warmScreen(key: string, url: string): void {
  void loadScreen(key, url, { warm: true }).catch(() => {});
}

/** Library list. Home and the dashboard chrome only. */
export function warmJobs(): void {
  warmScreen(SCREEN_JOBS, JOBS_URL);
}

/**
 * Voice catalog. This hits `GET /api/tts/voices`, which can start a GPU
 * restore when the account has a trained clone. Call it from the Voices
 * page or from a hover on the Voices link, not from every route.
 */
export function warmVoices(): void {
  warmScreen(SCREEN_VOICES, VOICES_URL);
}

/** Drop one screen so the next read cannot reuse a list from before a create. */
export function invalidateScreen(key: string): void {
  generation += 1;
  store.delete(key);
  inflight.delete(key);
}

export function onScreenCacheReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

export function resetScreenCache(): void {
  generation += 1;
  store.clear();
  inflight.clear();
  for (const listener of resetListeners) listener();
}
