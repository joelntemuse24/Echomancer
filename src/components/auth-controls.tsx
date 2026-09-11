"use client";

import { DrawablyButton } from "drawably/react";
import { signInWithGoogle } from "@/lib/auth/actions";
import type { ViewerIdentity } from "@/lib/auth/identity";
import { sketchSeed } from "@/lib/sketch-seed";
import { LANDING } from "@/lib/ux-copy";
import { cn } from "@/lib/utils";

export function AuthControls({
  identity,
  callbackUrl,
  className,
  compact = false,
}: {
  identity: ViewerIdentity;
  callbackUrl?: string;
  className?: string;
  compact?: boolean;
}) {
  if (identity.signedIn) {
    const label = identity.name?.trim() || identity.email || "Signed in";
    return (
      <div className={cn("flex items-center gap-3", className)}>
        {!compact ? (
          <span className="max-w-[10rem] truncate text-sm text-muted-foreground">
            {label}
          </span>
        ) : null}
        <form action="/api/auth/logout" method="POST">
          <DrawablyButton
            type="submit"
            tone="neutral"
            seed={sketchSeed("auth-sign-out")}
          >
            {LANDING.signOutCta}
          </DrawablyButton>
        </form>
      </div>
    );
  }

  return (
    <form
      action={async () => {
        await signInWithGoogle(callbackUrl);
      }}
      className={className}
    >
      <DrawablyButton type="submit" seed={sketchSeed("auth-sign-in")}>
        {LANDING.signInCta}
      </DrawablyButton>
    </form>
  );
}
