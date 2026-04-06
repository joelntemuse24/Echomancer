"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { FileAudio, ListOrdered, CreditCard, LogOut, Menu, X, BookOpen } from "lucide-react";
import { useState } from "react";

const navItems = [
  { href: "/dashboard", label: "New Audiobook", icon: FileAudio },
  { href: "/dashboard/queue", label: "Queue", icon: ListOrdered },
  { href: "/dashboard/subscription", label: "Subscription", icon: CreditCard },
  { href: "/dashboard/resources", label: "Resources", icon: BookOpen },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isActive = (href: string) => {
    if (href === "/dashboard") {
      return pathname === "/dashboard" || pathname.startsWith("/dashboard/upload") || pathname.startsWith("/dashboard/voice");
    }
    return pathname.startsWith(href);
  };

  return (
    <div className="min-h-screen bg-[#0d0d0d] flex">
      {/* Sidebar - Desktop */}
      <aside className="hidden md:flex w-64 border-r border-[#2a2a2a] bg-[#141414] flex-col shrink-0">
        <div className="p-6 border-b border-[#2a2a2a]">
          <Logo size="md" />
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href}>
              <Button
                variant="ghost"
                className={`w-full justify-start gap-3 h-11 transition-all duration-200 ${
                  isActive(item.href)
                    ? "bg-[#D97757]/10 text-[#D97757] border-l-2 border-[#D97757] rounded-l-none rounded-r-md"
                    : "text-[#a39b8f] hover:bg-[#242424] hover:text-[#faf9f7] border-l-2 border-transparent"
                }`}
              >
                <item.icon className={`w-5 h-5 ${isActive(item.href) ? "text-[#D97757]" : ""}`} />
                {item.label}
              </Button>
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t border-[#2a2a2a] space-y-1">
          <Link href="/">
            <Button
              variant="ghost"
              className="w-full justify-start gap-3 text-[#a39b8f] hover:bg-[#242424] hover:text-[#faf9f7]"
            >
              <LogOut className="w-5 h-5" />
              Logout
            </Button>
          </Link>
          <div className="pt-2">
            <ThemeToggle />
          </div>
        </div>
      </aside>

      {/* Mobile Menu Button */}
      <div className="md:hidden fixed top-4 left-4 z-50">
        <Button
          variant="outline"
          size="icon"
          className="bg-[#1a1a1a]/80 backdrop-blur-sm border-[#333]"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        >
          {mobileMenuOpen ? <X className="w-5 h-5 text-[#faf9f7]" /> : <Menu className="w-5 h-5 text-[#faf9f7]" />}
        </Button>
      </div>

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div
          className="md:hidden fixed inset-0 bg-[#0d0d0d]/90 backdrop-blur-sm z-40"
          onClick={() => setMobileMenuOpen(false)}
        >
          <aside
            className="w-64 h-full bg-[#141414] border-r border-[#2a2a2a] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-[#2a2a2a] mt-16">
              <Logo size="md" />
            </div>
            <nav className="flex-1 p-4 space-y-1">
              {navItems.map((item) => (
                <Link key={item.href} href={item.href} onClick={() => setMobileMenuOpen(false)}>
                  <Button
                    variant="ghost"
                    className={`w-full justify-start gap-3 h-11 transition-all duration-200 ${
                      isActive(item.href)
                        ? "bg-[#D97757]/10 text-[#D97757] border-l-2 border-[#D97757] rounded-l-none rounded-r-md"
                        : "text-[#a39b8f] hover:bg-[#242424] hover:text-[#faf9f7] border-l-2 border-transparent"
                    }`}
                  >
                    <item.icon className={`w-5 h-5 ${isActive(item.href) ? "text-[#D97757]" : ""}`} />
                    {item.label}
                  </Button>
                </Link>
              ))}
            </nav>
            <div className="p-4 border-t border-[#2a2a2a]">
              <Link href="/" onClick={() => setMobileMenuOpen(false)}>
                <Button
                  variant="ghost"
                  className="w-full justify-start gap-3 text-[#a39b8f] hover:bg-[#242424] hover:text-[#faf9f7]"
                >
                  <LogOut className="w-5 h-5" />
                  Logout
                </Button>
              </Link>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <div className="container mx-auto px-4 md:px-8 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
