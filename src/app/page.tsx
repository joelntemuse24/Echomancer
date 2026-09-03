import { LandingPage } from "@/components/landing-page";
import { getViewerIdentity } from "@/lib/auth/identity";

export default async function Page() {
  const identity = await getViewerIdentity();
  return <LandingPage identity={identity} />;
}
