"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mic2, Library } from "lucide-react";
import { AuthControls } from "@/components/auth-controls";
import type { ViewerIdentity } from "@/lib/auth/identity";
import { UX } from "@/lib/ux-copy";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard/voice", label: "Voice", icon: Mic2 },
  { href: "/dashboard/queue", label: "Library", icon: Library },
];

export function DashboardChrome({
  identity,
  children,
}: {
  identity: ViewerIdentity;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const howItWorksActive = pathname.startsWith("/dashboard/resources");

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-50 bg-background/90 backdrop-blur">
        <div className="container mx-auto px-4">
          <div className="flex h-16 items-center justify-between gap-4">
            <Link href="/" className="font-serif text-lg tracking-tight text-foreground">
              Echomancer
            </Link>

            <nav className="hidden md:flex items-center gap-6">
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
                      "text-sm transition-colors pb-0.5",
                      isActive
                        ? "text-foreground border-b border-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <AuthControls
              identity={identity}
              callbackUrl={pathname || "/dashboard/queue"}
            />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 flex-1">{children}</main>

      <footer className="container mx-auto px-4 pb-24 md:pb-8">
        <Link
          href="/dashboard/resources"
          className={cn(
            "inline-block text-xs transition-colors",
            howItWorksActive
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {UX.howItWorks}
        </Link>
      </footer>

      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-background">
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
                  isActive ? "text-primary" : "text-muted-foreground"
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
