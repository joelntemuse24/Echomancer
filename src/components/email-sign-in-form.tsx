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
          className="w-full border-0 border-b border-foreground/20 bg-transparent py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/60 focus:outline-none"
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={status === "sending" || !email.trim()}
        className="inline-flex min-h-11 items-center text-sm text-foreground underline decoration-foreground/70 underline-offset-[7px] transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-30"
      >
        {status === "sending" ? SIGN_IN.emailSending : SIGN_IN.emailCta}
      </button>
    </form>
  );
}
