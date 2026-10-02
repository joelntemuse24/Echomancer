"use client";

import { useState } from "react";
import { SIGN_IN } from "@/lib/ux-copy";

type Status = "idle" | "sending" | "sent";

export function EmailSignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "sending") return;
    setStatus("sending");
    setError(null);
    try {
      const response = await fetch("/api/auth/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, next }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? SIGN_IN.unavailable);
        setStatus("idle");
        return;
      }
      setStatus("sent");
    } catch {
      setError(SIGN_IN.unavailable);
      setStatus("idle");
    }
  }

  if (status === "sent") {
    return (
      <div className="space-y-4" role="status">
        <p className="text-foreground">{SIGN_IN.sentTitle}</p>
        <p className="text-sm text-muted-foreground">{SIGN_IN.sentBody}</p>
        <button
          type="button"
          onClick={() => {
            setStatus("idle");
            setEmail("");
          }}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          {SIGN_IN.sentRetry}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <input
          aria-label="Email"
          type="email"
          name="email"
          required
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={SIGN_IN.emailPlaceholder}
          className="w-full border border-border/40 bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-border focus:outline-none"
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={status === "sending" || !email.trim()}
        className="inline-flex w-full items-center justify-center gap-2 px-5 py-2.5 text-sm bg-foreground text-background hover:bg-foreground/85 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {status === "sending" ? SIGN_IN.emailSending : SIGN_IN.emailCta}
      </button>
    </form>
  );
}
