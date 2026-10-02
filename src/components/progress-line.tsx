export function ProgressLine({
  value,
  label,
}: {
  value: number;
  label: string;
}) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div
      className="h-px w-full bg-foreground/20"
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-px bg-foreground" style={{ width: `${pct}%` }} />
    </div>
  );
}
