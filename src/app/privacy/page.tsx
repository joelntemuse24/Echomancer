import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { PRIVACY } from "@/lib/ux-copy";

export const metadata: Metadata = {
  title: "Privacy — Echomancer",
  description:
    "What Echomancer stores when you upload a book, clone a voice, or sign in with Google.",
};

const sections = [
  PRIVACY.intro,
  PRIVACY.accounts,
  PRIVACY.books,
  PRIVACY.audio,
  PRIVACY.clones,
  PRIVACY.storage,
  PRIVACY.selling,
  PRIVACY.retention,
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background text-foreground font-serif px-8 py-16">
      <div className="max-w-xl mx-auto space-y-8">
        <p>
          <Link href="/" className="text-foreground hover:opacity-70">
            <Wordmark size="nav" />
          </Link>
        </p>
        <h1 className="text-5xl tracking-tight" style={{ fontWeight: 300 }}>
          {PRIVACY.title}
        </h1>
        <div className="space-y-5 text-lg leading-relaxed text-muted-foreground">
          {sections.map((paragraph) => (
            <p key={paragraph.slice(0, 24)}>{paragraph}</p>
          ))}
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
