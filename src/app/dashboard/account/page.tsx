"use client";

import { AccountSettings } from "@/components/account-settings";
import { useViewerIdentity } from "@/components/viewer-identity";
import { NAV } from "@/lib/ux-copy";

export default function AccountPage() {
  const identity = useViewerIdentity();
  if (!identity) {
    return (
      <div className="mx-auto max-w-lg pt-6" aria-busy="true">
        <h1
          className="font-serif text-5xl tracking-tight text-foreground"
          style={{ fontWeight: 300 }}
        >
          {NAV.account}
        </h1>
      </div>
    );
  }
  return <AccountSettings identity={identity} />;
}
