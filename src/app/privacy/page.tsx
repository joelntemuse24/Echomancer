import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { PRIVACY } from "@/lib/ux-copy";

export const metadata: Metadata = {
  title: "Privacy — Echomancer",
  description:
    "What Echomancer stores when you upload a book, clone a voice, or sign in with Google or email.",
};

const sections = [
  PRIVACY.intro,
  PRIVACY.accounts,
  PRIVACY.books,
  PRIVACY.processing,
  PRIVACY.audio,
  PRIVACY.clones,
  PRIVACY.storage,
  PRIVACY.selling,
  PRIVACY.retention,
  PRIVACY.review,
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background px-8 py-24 font-sans text-foreground">
      <div className="mx-auto max-w-xl space-y-12">
        <p>
          <Link href="/" className="text-foreground hover:opacity-70">
            <Wordmark size="nav" />
          </Link>
        </p>
        <h1 className="font-serif text-5xl tracking-tight md:text-6xl" style={{ fontWeight: 300 }}>
          {PRIVACY.title}
        </h1>
        <div className="space-y-8 text-base leading-relaxed text-muted-foreground">
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
