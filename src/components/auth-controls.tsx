"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signInWithGoogle } from "@/lib/auth/actions";
import type { ViewerIdentity } from "@/lib/auth/identity";
import { LANDING, NAV } from "@/lib/ux-copy";
import { DarkModeToggle } from "@/components/dark-mode-toggle";

const MENU_ITEM_CLASS =
  "block w-full px-3 py-1.5 text-left text-sm text-foreground/90 hover:text-foreground";

export function AuthControls({
  identity,
  callbackUrl,
  menu = true,
}: {
  identity: ViewerIdentity;
  callbackUrl?: string;
  /** Signed out: open a small menu from "Sign in" instead of signing in directly. */
  menu?: boolean;
}) {
  if (!identity.googleEnabled && !identity.emailEnabled) return null;
  if (identity.signedIn) {
    return <AccountMenu identity={identity} />;
  }
  if (menu) {
    return (
      <HeaderMenu label={LANDING.signInCta}>
        {(close) => (
          <>
            <SignInAction
              identity={identity}
              callbackUrl={callbackUrl}
              className={MENU_ITEM_CLASS}
              onClick={close}
              role="menuitem"
            />
            <MenuLink href="/dashboard/voice" onClick={close}>
              {NAV.voices}
            </MenuLink>
            <MenuLink href="/dashboard/queue" onClick={close}>
              {NAV.library}
            </MenuLink>
          </>
        )}
      </HeaderMenu>
    );
  }
  return (
    <SignInAction
      identity={identity}
      callbackUrl={callbackUrl}
      className="text-sm text-muted-foreground hover:text-foreground"
    />
  );
}

function SignInAction({
  identity,
  callbackUrl,
  className,
  onClick,
  role,
}: {
  identity: ViewerIdentity;
  callbackUrl?: string;
  className: string;
  onClick?: () => void;
  role?: "menuitem";
}) {
  if (identity.emailEnabled) {
    return (
      <Link
        href={
          callbackUrl
            ? `/sign-in?next=${encodeURIComponent(callbackUrl)}`
            : "/sign-in"
        }
        role={role}
        onClick={onClick}
        className={className}
      >
        {LANDING.signInCta}
      </Link>
    );
  }
  return (
    <form
      action={async () => {
        await signInWithGoogle(callbackUrl);
      }}
    >
      <button type="submit" role={role} className={className}>
        {LANDING.signInCta}
      </button>
    </form>
  );
}

function MenuLink({
  href,
  onClick,
  children,
}: {
  href: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} role="menuitem" onClick={onClick} className={MENU_ITEM_CLASS}>
      {children}
    </Link>
  );
}

function AccountMenu({
  identity,
}: {
  identity: Extract<ViewerIdentity, { signedIn: true }>;
}) {
  const label = identity.name || identity.email || NAV.account;
  return (
    <HeaderMenu label={label}>
      {(close) => (
        <>
          <MenuLink href="/dashboard/account" onClick={close}>
            {NAV.settings}
          </MenuLink>
          <MenuLink href="/dashboard/voice" onClick={close}>
            {NAV.voices}
          </MenuLink>
          <MenuLink href="/dashboard/queue" onClick={close}>
            {NAV.library}
          </MenuLink>
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
        </>
      )}
    </HeaderMenu>
  );
}

function HeaderMenu({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
        className="tap max-w-[12rem] truncate text-sm text-muted-foreground hover:text-foreground"
      >
        {label}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-3 min-w-[11rem] border border-border/40 bg-background/95 py-2 backdrop-blur"
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
