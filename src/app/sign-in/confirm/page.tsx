import type { Metadata } from "next";
import Link from "next/link";
import { SiteFrame } from "@/components/site-frame";
import { safeNextPath } from "@/lib/auth/email-login";
import { getViewerIdentity } from "@/lib/auth/identity";
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
  const identity = await getViewerIdentity();

  return (
    <SiteFrame identity={identity}>
      <main className="mx-auto max-w-sm">
        <h1 className="font-serif text-5xl font-light tracking-tight">
          {SIGN_IN.confirmTitle}
        </h1>

        {looksValid ? (
          <form action="/api/auth/email/verify" method="POST" className="mt-12 space-y-8">
            <p className="text-sm text-muted-foreground">{SIGN_IN.confirmBody}</p>
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="next" value={next} />
            <button
              type="submit"
              className="inline-flex min-h-11 items-center text-sm text-foreground underline decoration-foreground/70 underline-offset-[7px]"
            >
              {SIGN_IN.confirmCta}
            </button>
          </form>
        ) : (
          <div className="mt-12 space-y-4">
            <p className="text-sm text-muted-foreground">{SIGN_IN.confirmMissing}</p>
            <Link
              href="/sign-in"
              className="inline-flex min-h-11 items-center text-sm text-foreground underline decoration-foreground/70 underline-offset-[7px]"
            >
              {SIGN_IN.title}
            </Link>
          </div>
        )}
      </main>
    </SiteFrame>
  );
}
