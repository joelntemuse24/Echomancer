"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import { browserPrefStore } from "@/lib/player/player-prefs";
import {
  RESUME_SAVE_INTERVAL_MS,
  preferResume,
  readStoredResume,
  shouldPersistPlayhead,
  writeStoredResume,
  type ResumeSaveReason,
  type StoredResume,
} from "@/lib/player/playback-position";

/**
 * Local copy of the listening position, written immediately, plus a server
 * copy so a signed-in library follows the listener to another device.
 * The first paint reads localStorage. The server value replaces it only
 * when it is newer and the listener has not already moved the playhead.
 */
export function usePlaybackResume(jobId: string, enabled: boolean) {
  const savedRef = useRef<StoredResume | null>(null);
  const movedRef = useRef(false);
  const gateRef = useRef(true);
  const lastWriteRef = useRef(0);
  const lastNetRef = useRef(0);

  useLayoutEffect(() => {
    savedRef.current = readStoredResume(browserPrefStore(), jobId);
    movedRef.current = false;
    gateRef.current = true;
    lastWriteRef.current = 0;
    lastNetRef.current = 0;
  }, [jobId]);

  const remember = useCallback(
    (
      snapshot: { positionSeconds: number; sectionIndex: number | null },
      reason: ResumeSaveReason
    ) => {
      if (!enabled) return;
      const now = Date.now();
      if (
        !shouldPersistPlayhead({
          reason,
          elapsedMs: now - lastWriteRef.current,
          gated: gateRef.current,
        })
      ) {
        return;
      }
      if (reason === "seek" || reason === "track") {
        movedRef.current = true;
        gateRef.current = false;
      }
      const stored: StoredResume = {
        positionSeconds: snapshot.positionSeconds,
        sectionIndex: snapshot.sectionIndex,
        updatedAt: Math.floor(now / 1000),
      };
      savedRef.current = stored;
      writeStoredResume(browserPrefStore(), jobId, stored);
      lastWriteRef.current = now;
      if (reason === "tick" && now - lastNetRef.current < RESUME_SAVE_INTERVAL_MS) return;
      lastNetRef.current = now;
      void fetch(`/api/jobs/${jobId}/position`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          positionSeconds: stored.positionSeconds,
          sectionIndex: stored.sectionIndex,
        }),
        keepalive: true,
      }).catch(() => {});
    },
    [enabled, jobId]
  );

  const noteServer = useCallback(
    (remote: StoredResume | null): StoredResume | null => {
      if (movedRef.current) return savedRef.current;
      const chosen = preferResume(savedRef.current, remote);
      if (chosen && chosen !== savedRef.current) {
        savedRef.current = chosen;
        writeStoredResume(browserPrefStore(), jobId, chosen);
      }
      return savedRef.current;
    },
    [jobId]
  );

  const releaseGate = useCallback(() => {
    gateRef.current = false;
  }, []);

  return { savedRef, movedRef, remember, noteServer, releaseGate };
}
