"use client";

import { signInWithGoogle } from "@/lib/auth/actions";
import type { ViewerIdentity } from "@/lib/auth/identity";
import { LANDING } from "@/lib/ux-copy";

export function AuthControls({
  identity,
  callbackUrl,
  className,
  placement = "header",
}: {
  identity: ViewerIdentity;
  callbackUrl?: string;
  className?: string;
  /** Header: Sign in only. Footer: Sign out only. */
  placement?: "header" | "footer";
}) {
  if (identity.signedIn) {
    if (placement === "header") return null;
    return (
      <form action="/api/auth/logout" method="POST" className={className}>
        <button
          type="submit"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {LANDING.signOutCta}
        </button>
      </form>
    );
  }

  if (placement === "footer") return null;

  return (
    <form
      action={async () => {
        await signInWithGoogle(callbackUrl);
      }}
      className={className}
    >
      <button
        type="submit"
        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        {LANDING.signInCta}
      </button>
    </form>
  );
}
