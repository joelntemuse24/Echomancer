"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signInWithGoogle } from "@/lib/auth/actions";
import type { ViewerIdentity } from "@/lib/auth/identity";
import { LANDING, NAV } from "@/lib/ux-copy";
import { DarkModeToggle } from "@/components/dark-mode-toggle";

const MENU_ITEM_CLASS =
  "flex min-h-11 w-full items-center px-1 text-left text-sm text-foreground/90 hover:text-foreground";

export function AuthControls({
  identity,
  callbackUrl,
  menu = true,
  menuPlacement = "down",
  menuAlign = "right",
}: {
  identity: ViewerIdentity;
  callbackUrl?: string;
  /** Signed out: open a small menu from "Sign in" instead of signing in directly. */
  menu?: boolean;
  menuPlacement?: "up" | "down";
  menuAlign?: "left" | "right";
}) {
  if (!identity.googleEnabled && !identity.emailEnabled) return null;
  if (identity.signedIn) {
    return (
      <AccountMenu
        identity={identity}
        menuPlacement={menuPlacement}
        menuAlign={menuAlign}
      />
    );
  }
  if (menu) {
    return (
      <HeaderMenu
        label={LANDING.signInCta}
        placement={menuPlacement}
        align={menuAlign}
      >
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
  menuPlacement,
  menuAlign,
}: {
  identity: Extract<ViewerIdentity, { signedIn: true }>;
  menuPlacement: "up" | "down";
  menuAlign: "left" | "right";
}) {
  const label = identity.name || identity.email || NAV.account;
  return (
    <HeaderMenu label={label} placement={menuPlacement} align={menuAlign}>
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
            className="flex min-h-11 w-full items-center justify-between px-1 text-left text-sm text-foreground/90 hover:text-foreground"
          />
          <form action="/api/auth/logout" method="POST">
            <button
              type="submit"
              role="menuitem"
              className="flex min-h-11 w-full items-center px-1 text-left text-sm text-muted-foreground hover:text-foreground"
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
  placement,
  align,
}: {
  label: string;
  children: (close: () => void) => React.ReactNode;
  placement: "up" | "down";
  align: "left" | "right";
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
        className="inline-flex min-h-11 max-w-[12rem] items-center truncate text-sm text-muted-foreground hover:text-foreground"
      >
        {label}
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute z-40 min-w-[11rem] bg-background py-1 ${
            align === "left" ? "left-0" : "right-0"
          } ${placement === "up" ? "bottom-full mb-1" : "top-full mt-1"}`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
