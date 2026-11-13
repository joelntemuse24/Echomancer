"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mic2, Library, Plus } from "lucide-react";
import { AuthControls } from "@/components/auth-controls";
import { useViewerIdentity } from "@/components/viewer-identity";
import { Wordmark } from "@/components/wordmark";
import { prepareNewAudiobook } from "@/lib/capacity/client";
import {
  CREATE_HREF,
  DASHBOARD_NAV,
  LIBRARY_HREF,
  PREFETCH_SCREEN,
  VOICES_HREF,
} from "@/lib/nav/routes";
import { warmJobs, warmVoices } from "@/lib/nav/screen-cache";
import { NAV } from "@/lib/ux-copy";
import { cn } from "@/lib/utils";

const navItems = DASHBOARD_NAV.map((item) => ({
  href: item.href,
  label: item.href === VOICES_HREF ? NAV.voices : NAV.library,
  icon: item.href === VOICES_HREF ? Mic2 : Library,
}));

function voicesIntent(href: string): { onMouseEnter?: () => void; onFocus?: () => void } {
  if (href !== VOICES_HREF) return {};
  const warm = () => warmVoices();
  return { onMouseEnter: warm, onFocus: warm };
}

export function DashboardChrome({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const identity = useViewerIdentity();

  useEffect(() => {
    warmJobs();
  }, []);

  return (
    <div className="min-h-screen flex flex-col font-sans">
      <header className="sticky top-0 z-50 bg-background">
        <div className="container mx-auto px-4">
          <div className="flex h-16 items-center justify-between gap-4">
            <Link
              href={CREATE_HREF}
              prefetch={PREFETCH_SCREEN}
              className="text-foreground hover:opacity-70 transition-opacity"
            >
              <Wordmark size="nav" />
            </Link>

            <div className="flex items-center gap-6">
              <nav className="hidden md:flex items-center gap-6">
                {navItems.map((item) => {
                  const isActive =
                    pathname.startsWith(item.href) ||
                    (item.href === LIBRARY_HREF &&
                      pathname.startsWith("/dashboard/player"));
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      prefetch={PREFETCH_SCREEN}
                      {...voicesIntent(item.href)}
                      className={cn(
                        "text-sm transition-colors pb-0.5",
                        isActive
                          ? "border-b border-foreground font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
              <Link
                href={CREATE_HREF}
                prefetch={PREFETCH_SCREEN}
                aria-label="New audiobook"
                onClick={() => prepareNewAudiobook()}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-foreground/15 text-muted-foreground transition-colors hover:text-foreground"
              >
                <Plus aria-hidden="true" className="h-4 w-4" strokeWidth={1.5} />
              </Link>
              <AuthControls
                identity={identity}
                callbackUrl={pathname || "/dashboard/queue"}
                menu={false}
              />
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto flex-1 px-6 py-12 md:px-8 md:py-16">
        {children}
      </main>

      <footer className="container mx-auto px-4 pb-24 md:pb-8">
        <div className="flex justify-end">
          <Link
            href="/privacy"
            className="text-xs text-foreground/35 transition-colors hover:text-foreground/70"
          >
            Privacy
          </Link>
        </div>
      </footer>

      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-background">
        <div className="flex justify-around py-2">
          {navItems.map((item) => {
            const isActive =
              pathname.startsWith(item.href) ||
              (item.href === LIBRARY_HREF &&
                pathname.startsWith("/dashboard/player"));
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={PREFETCH_SCREEN}
                {...voicesIntent(item.href)}
                className={cn(
                  "flex flex-col items-center gap-1 px-3 py-2 text-xs",
                  isActive ? "font-medium text-foreground" : "text-muted-foreground"
                )}
              >
                <item.icon className="h-5 w-5" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
