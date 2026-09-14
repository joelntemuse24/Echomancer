"use client";

import Link from "next/link";
import { AuthControls } from "@/components/auth-controls";
import { DarkModeToggle } from "@/components/dark-mode-toggle";
import type { ViewerIdentity } from "@/lib/auth/identity";
import { NAV } from "@/lib/ux-copy";

export function AccountSettings({ identity }: { identity: ViewerIdentity }) {
  if (!identity.signedIn) {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <h1 className="font-serif text-4xl tracking-tight text-foreground">
          {NAV.account}
        </h1>
        <p className="text-sm text-muted-foreground">
          Sign in to see your account.
        </p>
        <AuthControls identity={identity} callbackUrl="/dashboard/account" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-10">
      <div>
        <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          {NAV.account}
        </p>
        <h1 className="mt-3 font-serif text-4xl tracking-tight text-foreground">
          {NAV.settings}
        </h1>
      </div>

      <dl className="space-y-5 text-sm">
        <div>
          <dt className="text-muted-foreground">Name</dt>
          <dd className="mt-1 text-foreground">{identity.name || "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Email</dt>
          <dd className="mt-1 text-foreground">{identity.email || "—"}</dd>
        </div>
      </dl>

      <DarkModeToggle className="flex w-full items-center justify-between text-sm text-foreground" />

      <div className="flex items-center justify-between gap-6 text-sm">
        <Link href="/dashboard/queue" className="text-muted-foreground hover:text-foreground">
          {NAV.library}
        </Link>
        <form action="/api/auth/logout" method="POST">
          <button type="submit" className="text-muted-foreground hover:text-foreground">
            {NAV.signOut}
          </button>
        </form>
      </div>
    </div>
  );
}
