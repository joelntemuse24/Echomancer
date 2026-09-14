import { AccountSettings } from "@/components/account-settings";
import { getViewerIdentity } from "@/lib/auth/identity";

export default async function AccountPage() {
  const identity = await getViewerIdentity();
  return <AccountSettings identity={identity} />;
}
