import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { safeNextPath } from "@/lib/auth/email-login";
import { SIGN_IN } from "@/lib/ux-copy";

// The token is in the URL: keep it out of Referer headers sent to other sites
// and out of search results. Not "no-referrer": that makes the confirm form
// post `Origin: null`, which the same-origin check cannot tell from an attack.
export const metadata: Metadata = {
  title: "Sign in — Echomancer",
  robots: { index: false },
  referrer: "same-origin",
};

type SearchParams = Promise<{ token?: string; next?: string }>;

/**
 * Landing page for the emailed link. Loading it consumes nothing: mail
 * scanners and link previews that fetch it must not burn the single-use token.
 * Signing in happens only on the button press (a same-origin POST).
 */
export default async function ConfirmSignInPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const next = safeNextPath(params.next);
  const looksValid = /^[0-9a-f]{64}$/.test(token);

  return (
    <main className="min-h-screen bg-background px-8 py-24 font-serif text-foreground">
      <div className="mx-auto max-w-sm space-y-12 font-sans">
        <p>
          <Link href="/" className="text-foreground hover:opacity-70">
            <Wordmark size="nav" />
          </Link>
        </p>
        <h1
          className="font-serif text-5xl tracking-tight"
          style={{ fontWeight: 300 }}
        >
          {SIGN_IN.confirmTitle}
        </h1>

        {looksValid ? (
          <form action="/api/auth/email/verify" method="POST" className="space-y-6">
            <p className="text-sm text-muted-foreground">{SIGN_IN.confirmBody}</p>
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="next" value={next} />
            <button
              type="submit"
              className="inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 text-sm bg-foreground text-background hover:bg-foreground/85 transition-colors"
            >
              {SIGN_IN.confirmCta}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{SIGN_IN.confirmMissing}</p>
            <Link
              href="/sign-in"
              className="text-sm text-foreground underline underline-offset-4"
            >
              {SIGN_IN.title}
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
