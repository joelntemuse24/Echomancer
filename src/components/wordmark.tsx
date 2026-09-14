import { cn } from "@/lib/utils";

type WordmarkSize = "hero" | "nav";

const SIZE_CLASS: Record<WordmarkSize, string> = {
  hero: "text-5xl sm:text-6xl",
  nav: "text-2xl",
};

export function Wordmark({
  size,
  className,
}: {
  size: WordmarkSize;
  className?: string;
}) {
  return (
    <span
      className={cn("font-serif tracking-tight", SIZE_CLASS[size], className)}
      style={{ letterSpacing: "-0.03em", fontWeight: 300 }}
    >
      Echomancer
    </span>
  );
}
