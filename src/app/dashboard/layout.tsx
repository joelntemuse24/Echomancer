import { DashboardChrome } from "./chrome";
import { getViewerIdentity } from "@/lib/auth/identity";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const identity = await getViewerIdentity();
  return <DashboardChrome identity={identity}>{children}</DashboardChrome>;
}
