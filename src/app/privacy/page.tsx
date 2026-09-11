import type { Metadata } from "next";
import Link from "next/link";
import { PRIVACY } from "@/lib/ux-copy";

export const metadata: Metadata = {
  title: "Privacy — Echomancer",
  description:
    "What Echomancer stores: uploads, voice clones, Google sign-in, and where data lives.",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background text-foreground font-serif px-8 py-16">
      <div className="max-w-xl mx-auto space-y-8">
        <p className="text-sm tracking-[0.2em] uppercase">
          <Link href="/" className="hover:text-muted-foreground">
            Echomancer
          </Link>
        </p>
        <h1
          className="text-5xl tracking-tight"
          style={{ fontWeight: 300 }}
        >
          {PRIVACY.title}
        </h1>
        <div className="space-y-4 text-base leading-relaxed text-muted-foreground">
          <p>{PRIVACY.site}</p>
          <p>{PRIVACY.uploads}</p>
          <p>{PRIVACY.clones}</p>
          <p>{PRIVACY.auth}</p>
          <p>{PRIVACY.storage}</p>
          <p>{PRIVACY.selling}</p>
          <p>
            Questions:{" "}
            <a
              href="mailto:ntemusejoel@gmail.com"
              className="text-foreground underline underline-offset-4"
            >
              ntemusejoel@gmail.com
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
