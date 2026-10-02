import { LandingPage } from "@/components/landing-page";
import { SiteFrame } from "@/components/site-frame";
import { getViewerIdentity } from "@/lib/auth/identity";

export default async function Page() {
  const identity = await getViewerIdentity();
  return (
    <SiteFrame identity={identity} centered>
      <LandingPage />
    </SiteFrame>
  );
}
