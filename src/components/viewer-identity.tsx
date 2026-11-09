"use client";

import { createContext, useContext } from "react";
import type { ViewerIdentity } from "@/lib/auth/identity";

const ViewerIdentityContext = createContext<ViewerIdentity | null>(null);

export function ViewerIdentityProvider({
  identity,
  children,
}: {
  identity: ViewerIdentity;
  children: React.ReactNode;
}) {
  return (
    <ViewerIdentityContext.Provider value={identity}>
      {children}
    </ViewerIdentityContext.Provider>
  );
}

export function useViewerIdentity(): ViewerIdentity | null {
  return useContext(ViewerIdentityContext);
}
