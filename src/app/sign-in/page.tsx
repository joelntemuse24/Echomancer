import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { EmailSignInForm } from "@/components/email-sign-in-form";
import { Wordmark } from "@/components/wordmark";
import { signInWithGoogle } from "@/lib/auth/actions";
import { safeNextPath } from "@/lib/auth/email-login";
import { getViewerIdentity } from "@/lib/auth/identity";
import { SIGN_IN } from "@/lib/ux-copy";

export const metadata: Metadata = {
  title: "Sign in — Echomancer",
  robots: { index: false },
};

type SearchParams = Promise<{ error?: string; next?: string }>;

export default async function SignInPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  const identity = await getViewerIdentity();
  if (identity.signedIn) redirect(next);

  const notice =
    params.error === "expired"
      ? SIGN_IN.expired
      : params.error
        ? SIGN_IN.invalid
        : null;
  const available = identity.googleEnabled || identity.emailEnabled;

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
          {SIGN_IN.title}
        </h1>

        {notice ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}

        {!available ? (
          <p className="text-sm text-muted-foreground">{SIGN_IN.unavailable}</p>
        ) : null}

        {identity.googleEnabled ? (
          <form action={signInWithGoogle.bind(null, next)}>
            <button
              type="submit"
              className="inline-flex w-full items-center justify-center gap-2 border border-border/40 px-5 py-2.5 text-sm text-foreground hover:border-border transition-colors"
            >
              {SIGN_IN.google}
            </button>
          </form>
        ) : null}

        {identity.googleEnabled && identity.emailEnabled ? (
          <p className="text-center text-xs text-muted-foreground">
            {SIGN_IN.divider}
          </p>
        ) : null}

        {identity.emailEnabled ? <EmailSignInForm next={next} /> : null}
      </div>
    </main>
  );
}
