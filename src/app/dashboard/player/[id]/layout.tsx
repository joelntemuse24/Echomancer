import Link from "next/link";
import { operatorToolsEnabled } from "@/lib/operator/tools";

/**
 * When operator tools are on, a quiet Markup link sits under the player.
 * The flag is off in production until `ECHO_OPERATOR_TOOLS=1`, so the
 * default player chrome never includes it.
 */
export default async function PlayerJobLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  if (!operatorToolsEnabled()) return children;
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
