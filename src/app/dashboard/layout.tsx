import { SiteFrame } from "@/components/site-frame";
import { getViewerIdentity } from "@/lib/auth/identity";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const identity = await getViewerIdentity();
  return <SiteFrame identity={identity}>{children}</SiteFrame>;
}
