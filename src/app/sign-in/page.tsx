import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EmailSignInForm } from "@/components/email-sign-in-form";
import { SiteFrame } from "@/components/site-frame";
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
    <SiteFrame identity={identity}>
      <main className="mx-auto max-w-sm">
        <h1 className="font-serif text-5xl font-light tracking-tight">
          {SIGN_IN.title}
        </h1>

        {notice ? (
          <p role="alert" className="mt-8 text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}

        {!available ? (
          <p className="mt-8 text-sm text-muted-foreground">{SIGN_IN.unavailable}</p>
        ) : null}

        <div className="mt-12 space-y-8">
          {identity.googleEnabled ? (
            <form action={signInWithGoogle.bind(null, next)}>
              <button
                type="submit"
                className="inline-flex min-h-11 items-center text-sm text-foreground underline decoration-foreground/70 underline-offset-[7px]"
              >
                {SIGN_IN.google}
              </button>
            </form>
          ) : null}

          {identity.googleEnabled && identity.emailEnabled ? (
            <p className="text-sm text-muted-foreground">{SIGN_IN.divider}</p>
          ) : null}

          {identity.emailEnabled ? <EmailSignInForm next={next} /> : null}
        </div>
      </main>
    </SiteFrame>
  );
}
