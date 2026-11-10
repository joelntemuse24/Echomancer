"use client";

import { useEffect } from "react";
import { loadViewerIdentity } from "@/components/viewer-identity";
import { warmAppScreens } from "@/lib/nav/screen-cache";

/**
 * Start identity, the library, and the voice catalog as soon as the shell
 * is on screen. The root layout does not remount between Home, Library,
 * and Voices, so this runs once per visit and the next click reads the cache.
 */
export function NavigationWarmup() {
  useEffect(() => {
    void loadViewerIdentity();
    warmAppScreens();
  }, []);
  return null;
}
