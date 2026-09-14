"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signInWithGoogle } from "@/lib/auth/actions";
import type { ViewerIdentity } from "@/lib/auth/identity";
import { LANDING, NAV } from "@/lib/ux-copy";
import { DarkModeToggle } from "@/components/dark-mode-toggle";

export function AuthControls({
  identity,
  callbackUrl,
}: {
  identity: ViewerIdentity;
  callbackUrl?: string;
}) {
  if (!identity.googleEnabled) return null;
  if (identity.signedIn) {
    return <AccountMenu identity={identity} />;
  }
  return (
    <form
      action={async () => {
        await signInWithGoogle(callbackUrl);
      }}
    >
      <button
        type="submit"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        {LANDING.signInCta}
      </button>
    </form>
  );
}

function AccountMenu({
  identity,
}: {
  identity: Extract<ViewerIdentity, { signedIn: true }>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const label = identity.name || identity.email || NAV.account;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        className="max-w-[12rem] truncate text-sm text-muted-foreground hover:text-foreground"
      >
        {label}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-3 min-w-[11rem] border border-border/40 bg-background/95 py-2 backdrop-blur"
        >
          <Link
            href="/dashboard/account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-1.5 text-sm text-foreground/90 hover:text-foreground"
          >
            {NAV.settings}
          </Link>
          <Link
            href="/dashboard/queue"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-1.5 text-sm text-foreground/90 hover:text-foreground"
          >
            {NAV.library}
          </Link>
          <DarkModeToggle
            role="menuitem"
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-foreground/90 hover:text-foreground"
          />
          <form action="/api/auth/logout" method="POST">
            <button
              type="submit"
              role="menuitem"
              className="w-full px-3 py-1.5 text-left text-sm text-muted-foreground hover:text-foreground"
            >
              {NAV.signOut}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
