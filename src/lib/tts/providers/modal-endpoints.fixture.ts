/**
 * Shared Modal endpoint fixtures for the clone suites.
 *
 * Each `@modal.fastapi_endpoint` is a **separate hostname**, so a test that
 * mocks `${base}/ready` and `${base}/synthesize` is testing a shape Modal does
 * not serve. These constants are the real shape, and the helpers assert on it.
 */

/** `synthesize_batch` endpoint host. */
export const BATCH_HOST = "https://acme--echomancer-s2-clone-synthesize-batch.modal.run";
/** Single-section `synthesize` endpoint host. */
export const SINGLE_HOST = "https://acme--echomancer-s2-clone-synthesize.modal.run";
/** `GET /ready` probe host. */
export const READY_HOST = "https://acme--echomancer-s2-clone-ready.modal.run";

/** Configure all three endpoints. */
export function stubModalEndpoints(
  stub: (name: string, value: string) => void,
  opts: { ready?: boolean; single?: boolean } = {}
): void {
  stub("MODAL_S2_TTS_URL", BATCH_HOST);
  if (opts.single !== false) stub("MODAL_S2_SYNTHESIZE_URL", SINGLE_HOST);
  stub("MODAL_S2_READY_URL", opts.ready === false ? "" : READY_HOST);
}

/**
 * Which endpoint a fetch call went to, by host. Returns null for anything that
 * is not one of our three hosts, so a test can prove no path was appended.
 */
export function endpointOf(url: string): "batch" | "single" | "ready" | null {
  if (url === BATCH_HOST) return "batch";
  if (url === SINGLE_HOST) return "single";
  if (url === READY_HOST) return "ready";
  return null;
}

/** True when the URL is one of our endpoint origins with nothing appended. */
export function isBareEndpoint(url: string): boolean {
  return endpointOf(url) !== null;
}

export function readyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ready: true,
    warm_containers: 2,
    max_containers: 1,
    lanes: 4,
    build: "abc123def456",
    version: "6",
    ...overrides,
  };
}
