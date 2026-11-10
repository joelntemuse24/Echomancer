/**
 * Shown only while the next dashboard segment's code is still arriving.
 * A short bar, not a fake list: the real page paints its own heading, and
 * a skeleton that doesn't match that heading reads as a flash.
 */
export default function DashboardLoading() {
  return (
    <div
      className="mx-auto w-full min-w-0 max-w-3xl pb-16"
      aria-busy="true"
    >
      <div className="h-12 w-40 rounded-sm bg-accent/40" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
