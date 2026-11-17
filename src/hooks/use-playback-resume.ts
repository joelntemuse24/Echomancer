"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import { browserPrefStore } from "@/lib/player/player-prefs";
import {
  RESUME_SAVE_INTERVAL_MS,
  preferResume,
  readStoredResume,
  samePlayhead,
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
 * The gate stays closed until the job response has been merged, so a
 * timeupdate at 0 cannot replace the stored row.
 */
export function usePlaybackResume(jobId: string, enabled: boolean) {
  const savedRef = useRef<StoredResume | null>(null);
  const movedRef = useRef(false);
  const gateRef = useRef(true);
  const lastWriteRef = useRef(0);
  const lastNetRef = useRef(0);
  const lastSentRef = useRef<{ positionSeconds: number; sectionIndex: number | null } | null>(null);
  /** `updated_at` last read from the server, or confirmed by a write. */
  const baseUpdatedAtRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    savedRef.current = readStoredResume(browserPrefStore(), jobId);
    movedRef.current = false;
    gateRef.current = true;
    lastWriteRef.current = 0;
    lastNetRef.current = 0;
    lastSentRef.current = null;
    baseUpdatedAtRef.current = savedRef.current?.updatedAt ?? null;
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
      const force = reason === "seek" || reason === "track";
      if (force) movedRef.current = true;
      if (!force && samePlayhead(lastSentRef.current, snapshot)) return;
      const updatedAt = baseUpdatedAtRef.current ?? Math.floor(now / 1000);
      const stored: StoredResume = {
        positionSeconds: snapshot.positionSeconds,
        sectionIndex: snapshot.sectionIndex,
        updatedAt,
      };
      savedRef.current = stored;
      writeStoredResume(browserPrefStore(), jobId, stored);
      lastWriteRef.current = now;
      if (reason === "tick" && now - lastNetRef.current < RESUME_SAVE_INTERVAL_MS) return;
      lastNetRef.current = now;
      const expectedUpdatedAt = baseUpdatedAtRef.current;
      void fetch(`/api/jobs/${jobId}/position`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          positionSeconds: stored.positionSeconds,
          sectionIndex: stored.sectionIndex,
          expectedUpdatedAt,
          force,
        }),
        keepalive: true,
      })
        .then(async (response) => {
          if (response.status === 409) return;
          if (!response.ok) return;
          const body = (await response.json()) as { updatedAt?: number };
          if (typeof body.updatedAt !== "number") return;
          baseUpdatedAtRef.current = body.updatedAt;
          const confirmed: StoredResume = {
            positionSeconds: snapshot.positionSeconds,
            sectionIndex: snapshot.sectionIndex,
            updatedAt: body.updatedAt,
          };
          savedRef.current = confirmed;
          writeStoredResume(browserPrefStore(), jobId, confirmed);
          lastSentRef.current = {
            positionSeconds: snapshot.positionSeconds,
            sectionIndex: snapshot.sectionIndex,
          };
        })
        .catch(() => {});
    },
    [enabled, jobId]
  );

  const noteServer = useCallback(
    (remote: StoredResume | null): StoredResume | null => {
      gateRef.current = false;
      if (!movedRef.current) {
        const chosen = preferResume(savedRef.current, remote);
        if (chosen && chosen !== savedRef.current) {
          savedRef.current = chosen;
          writeStoredResume(browserPrefStore(), jobId, chosen);
        }
      }
      const current = savedRef.current;
      if (current) {
        lastSentRef.current = {
          positionSeconds: current.positionSeconds,
          sectionIndex: current.sectionIndex,
        };
      }
      if (remote) baseUpdatedAtRef.current = remote.updatedAt;
      else if (current) baseUpdatedAtRef.current = current.updatedAt;
      return current;
    },
    [jobId]
  );

  /** The job request failed. Saving may start; there is no server row to protect. */
  const noteServerFailed = useCallback(() => {
    gateRef.current = false;
  }, []);

  /** Play is a move: the job response must not seek back over it. */
  const markMoved = useCallback(() => {
    movedRef.current = true;
  }, []);

  return { savedRef, movedRef, remember, noteServer, noteServerFailed, markMoved };
}
