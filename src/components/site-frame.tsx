import Link from "next/link";
import { AuthControls } from "@/components/auth-controls";
import { Wordmark } from "@/components/wordmark";
import type { ViewerIdentity } from "@/lib/auth/identity";
import { NAV } from "@/lib/ux-copy";
import { cn } from "@/lib/utils";

export function SiteFrame({
  identity,
  children,
  centered = false,
}: {
  identity: ViewerIdentity;
  children: React.ReactNode;
  /** Landing sits in the middle of the room. Other screens start under the rule. */
  centered?: boolean;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background font-sans text-foreground">
      <header className="sticky top-0 z-50 bg-background">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-5 sm:px-8">
          <Link href="/" className="text-foreground transition-opacity hover:opacity-70">
            <Wordmark size="nav" />
          </Link>
          <Link
            href="/dashboard/queue"
            className="inline-flex min-h-11 items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {NAV.library}
          </Link>
        </div>
        <div className="h-px bg-foreground/15" />
      </header>

      <div
        className={cn(
          "mx-auto w-full max-w-3xl flex-1 px-5 py-16 sm:px-8 sm:py-20",
          centered && "flex items-center"
        )}
      >
        {children}
      </div>

      <footer className="mx-auto flex w-full max-w-5xl items-center justify-between gap-6 px-5 py-8 sm:px-8">
        <AuthControls
          identity={identity}
          menuPlacement="up"
          menuAlign="left"
        />
        <Link
          href="/privacy"
          className="ml-auto inline-flex min-h-11 items-center text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Privacy
        </Link>
      </footer>
    </div>
  );
}
