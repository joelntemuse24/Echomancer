import Link from "next/link";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { isMarkupOperator } from "@/lib/operator/tools";

/**
 * A quiet Markup link under the player, only for an allowlisted operator.
 * Other signed-in owners do not see it. The link is not ownership-scoped:
 * the operator can open markup for whatever job id is in the URL.
 */
export default async function PlayerJobLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  if (!(await isMarkupOperator(session?.userId))) return children;
  const { id } = await params;
  return (
    <>
      {children}
      <div className="max-w-2xl mx-auto px-4 pb-8 text-center">
        <Link
          href={`/dashboard/player/${id}/markup`}
          className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground"
        >
          Markup
        </Link>
      </div>
    </>
  );
}
