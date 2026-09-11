"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mic2, Library, BookOpen } from "lucide-react";
import { DrawablyTabs, DrawablyUnderline } from "drawably/react";
import { AuthControls } from "@/components/auth-controls";
import type { ViewerIdentity } from "@/lib/auth/identity";
import { sketchSeed } from "@/lib/sketch-seed";
import { LANDING } from "@/lib/ux-copy";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard/voice", label: "Voice", icon: Mic2 },
  { href: "/dashboard/queue", label: LANDING.libraryCta, icon: Library },
  { href: "/dashboard/resources", label: "How it works", icon: BookOpen },
];

export function DashboardChrome({
  identity,
  children,
}: {
  identity: ViewerIdentity;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const activeIndex = navItems.findIndex((item) => {
    return (
      pathname.startsWith(item.href) ||
      (item.href === "/dashboard/queue" &&
        pathname.startsWith("/dashboard/player"))
    );
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto px-4">
          <div className="flex h-16 items-center justify-between gap-4">
            <Link
              href="/"
              className="font-serif text-xl font-semibold tracking-tight text-foreground"
            >
              <DrawablyUnderline seed={sketchSeed("chrome-wordmark")}>
                Echomancer
              </DrawablyUnderline>
            </Link>

            <DrawablyTabs
              active={Math.max(0, activeIndex)}
              seed={sketchSeed("chrome-nav")}
              className="hidden md:flex"
            >
              {navItems.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </DrawablyTabs>

            <AuthControls
              identity={identity}
              callbackUrl={pathname || "/dashboard/queue"}
            />
          </div>
        </div>
      </header>

      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-background">
        <div className="flex justify-around py-2">
          {navItems.map((item) => {
            const isActive =
              pathname.startsWith(item.href) ||
              (item.href === "/dashboard/queue" &&
                pathname.startsWith("/dashboard/player"));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex flex-col items-center gap-1 px-3 py-2 text-xs",
                  isActive ? "text-foreground" : "text-muted-foreground"
                )}
              >
                <item.icon className="h-5 w-5" />
                {isActive ? (
                  <DrawablyUnderline seed={sketchSeed(`chrome-mobile-${item.href}`)}>
                    {item.label}
                  </DrawablyUnderline>
                ) : (
                  item.label
                )}
              </Link>
            );
          })}
        </div>
      </nav>

      <main className="container mx-auto px-4 py-8 pb-24 md:pb-8">{children}</main>
    </div>
  );
}
