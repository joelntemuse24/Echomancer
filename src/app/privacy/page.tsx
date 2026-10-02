import type { Metadata } from "next";
import { SiteFrame } from "@/components/site-frame";
import { getViewerIdentity } from "@/lib/auth/identity";
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

export default async function PrivacyPage() {
  const identity = await getViewerIdentity();
  return (
    <SiteFrame identity={identity}>
      <main className="mx-auto max-w-xl">
        <h1 className="font-serif text-5xl font-light tracking-tight sm:text-6xl">
          {PRIVACY.title}
        </h1>
        <div className="mt-12 space-y-8 text-base leading-relaxed text-muted-foreground">
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
      </main>
    </SiteFrame>
  );
}
