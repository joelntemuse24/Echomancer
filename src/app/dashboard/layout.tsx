"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/Logo";
import { ListOrdered, Plus, BookOpen, Menu, X } from "lucide-react";
import { useState } from "react";
import { motion } from "motion/react";

const navItems = [
  { href: "/", label: "New Audiobook", icon: Plus },
  { href: "/dashboard/queue", label: "Library", icon: ListOrdered },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isActive = (href: string) => {
    return pathname === href || pathname.startsWith(href + "/");
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-serif">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 px-8 py-6 flex justify-between items-center border-b border-border/50 bg-background/80 backdrop-blur-sm">
        <div className="flex items-center gap-8">
          <Link href="/" className="text-sm tracking-[0.2em] uppercase hover:opacity-80 transition-opacity font-serif">
            Echomancer
          </Link>
          
          <div className="hidden md:flex gap-6 text-sm">
            {navItems.map((item) => (
              <Link 
                key={item.href} 
                href={item.href}
                className={`transition-colors flex items-center gap-2 ${
                  isActive(item.href) ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </Link>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-xs border border-border">
            U
          </div>
          
          {/* Mobile menu toggle */}
          <button 
            className="md:hidden text-muted-foreground"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </nav>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-x-0 top-[73px] z-40 bg-background border-b border-border/50 px-4 py-4 space-y-4">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileMenuOpen(false)}
              className={`flex items-center gap-3 px-4 py-3 rounded-sm transition-colors ${
                isActive(item.href) ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              }`}
            >
              <item.icon className="w-5 h-5" />
              {item.label}
            </Link>
          ))}
        </div>
      )}

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 md:px-8 py-8 md:py-12">
        {children}
      </main>
    </div>
  );
}
