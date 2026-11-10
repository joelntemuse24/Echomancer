import { Suspense } from "react";
import { OperatorMarkupLink } from "./markup-link";

/**
 * The player used to wait here on a session read before the page could
 * start. The book renders immediately. The operator link, if any, follows.
 */
export default function PlayerJobLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  return (
    <>
      {children}
      <Suspense fallback={null}>
        <OperatorMarkupLink params={params} />
      </Suspense>
    </>
  );
}
