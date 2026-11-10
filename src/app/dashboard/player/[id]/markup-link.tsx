"use client";

import Link from "next/link";
import { use } from "react";
import { useMarkupOperator } from "@/components/viewer-identity";

/**
 * The operator Voice text link. It used to be an async server layout that
 * read the session before the player could paint. The markup page still
 * 404s for everyone else; this only decides whether the link is drawn.
 */
export function OperatorMarkupLink({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const markup = useMarkupOperator();
  if (!markup) return null;
  return (
    <div className="mx-auto max-w-2xl px-4 pb-8 text-center">
      <Link
        href={`/dashboard/player/${id}/markup`}
        className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground"
      >
        Voice text
      </Link>
    </div>
  );
}
