"use client";

import { useTheme } from "next-themes";
import { NAV } from "@/lib/ux-copy";

export function DarkModeToggle({
  className,
  role,
}: {
  className?: string;
  role?: string;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme !== "light";

  return (
    <button
      type="button"
      role={role}
      className={className}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      <span>{NAV.darkMode}</span>
      <span className="text-xs text-muted-foreground">{dark ? "On" : "Off"}</span>
    </button>
  );
}
