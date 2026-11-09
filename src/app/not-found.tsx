import Link from "next/link";
import { Wordmark } from "@/components/wordmark";

/** Unmatched routes, including /terms. No legal page is invented here. */
export default function NotFound() {
  return (
    <main className="min-h-screen bg-background px-8 py-24 font-sans text-foreground">
      <div className="mx-auto max-w-xl space-y-12">
        <p>
          <Link href="/" className="text-foreground hover:opacity-70">
            <Wordmark size="nav" />
          </Link>
        </p>
        <h1
          className="font-serif text-5xl tracking-tight"
          style={{ fontWeight: 300 }}
        >
          This page is not here.
        </h1>
        <p>
          <Link
            href="/"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Home
          </Link>
        </p>
      </div>
    </main>
  );
}
