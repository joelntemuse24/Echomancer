"use client";

import { useEffect } from "react";
import { loadViewerIdentity } from "@/components/viewer-identity";

/**
 * Start the header read once per document. Jobs and voices are not warmed
 * here: the voice catalog can start a GPU restore, and this layout is also
 * Privacy, sign-in, and the player.
 */
export function NavigationWarmup() {
  useEffect(() => {
    void loadViewerIdentity().catch(() => {});
  }, []);
  return null;
}
