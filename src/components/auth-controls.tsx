"use client";

import { signInWithGoogle } from "@/lib/auth/actions";
import type { ViewerIdentity } from "@/lib/auth/identity";
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
          <button
            type="submit"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign out
          </button>
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
      <button
        type="submit"
        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        Sign in with Google
      </button>
    </form>
  );
}
