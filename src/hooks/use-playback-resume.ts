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

type Playhead = { positionSeconds: number; sectionIndex: number | null };

type PositionPayload = {
  positionSeconds?: number;
  sectionIndex?: number | null;
  updatedAt?: number;
};

/**
 * The page reports whether this tab is the one the listener is using,
 * the live playhead for one retry, and how to move an idle element.
 */
export type ResumeHost = {
  playing: () => boolean;
  live: () => Playhead | null;
  adopt: (row: StoredResume) => void;
};

/**
 * Local copy of the listening position, plus a server copy so a signed-in
 * library follows the listener to another device.
 *
 * The device being listened on wins. A tab that is playing, or that the
 * listener has seeked on since the last confirmed write, retries once
 * after a 409 with the clock the server just returned. An idle tab takes
 * that row instead. A rejected position is not stored as the winner.
 * The gate stays closed until the job response has been merged, so a
 * timeupdate at 0 cannot replace the stored row. Play before that merge
 * is not a move.
 */
export function usePlaybackResume(jobId: string, enabled: boolean) {
  const savedRef = useRef<StoredResume | null>(null);
  const movedRef = useRef(false);
  const gateRef = useRef(true);
  const lastWriteRef = useRef(0);
  const lastNetRef = useRef(0);
  const lastSentRef = useRef<Playhead | null>(null);
  /** `updated_at` last read from the server, or confirmed by a write. */
  const baseUpdatedAtRef = useRef<number | null>(null);
  /** A timestamp a 200 has confirmed. Later reads must not move the base behind it. */
  const confirmedUpdatedAtRef = useRef<number | null>(null);
  /** Seek or part change since the last 200. */
  const movedSinceConfirmRef = useRef(false);
  /**
   * The server row is known and the element has not taken it yet.
   * A tick must not write the unrestored playhead under that row's clock.
   */
  const holdUnrestoredRef = useRef(false);
  const hostRef = useRef<ResumeHost>({
    playing: () => false,
    live: () => null,
    adopt: () => {},
  });
  const sendRef = useRef<
    (snapshot: Playhead, force: boolean, allowRetry: boolean) => Promise<void>
  >(async () => {});

  useLayoutEffect(() => {
    savedRef.current = readStoredResume(browserPrefStore(), jobId);
    movedRef.current = false;
    movedSinceConfirmRef.current = false;
    gateRef.current = true;
    holdUnrestoredRef.current = false;
    lastWriteRef.current = 0;
    lastNetRef.current = 0;
    lastSentRef.current = null;
    confirmedUpdatedAtRef.current = null;
    baseUpdatedAtRef.current = savedRef.current?.updatedAt ?? null;
  }, [jobId]);

  const assignBase = useCallback((next: number | null) => {
    if (next == null || !Number.isFinite(next)) return;
    const floor = confirmedUpdatedAtRef.current;
    if (floor != null && next < floor) return;
    baseUpdatedAtRef.current = next;
  }, []);

  const storeRow = useCallback((row: StoredResume) => {
    savedRef.current = row;
    writeStoredResume(browserPrefStore(), jobId, row);
    lastSentRef.current = {
      positionSeconds: row.positionSeconds,
      sectionIndex: row.sectionIndex,
    };
  }, [jobId]);

  const readServer = useCallback(async (): Promise<StoredResume | null> => {
    const response = await fetch(`/api/jobs/${jobId}/position`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      positionSeconds?: number | null;
      sectionIndex?: number | null;
      updatedAt?: number | null;
    };
    if (typeof body.updatedAt !== "number" || typeof body.positionSeconds !== "number") return null;
    return {
      positionSeconds: body.positionSeconds,
      sectionIndex: body.sectionIndex ?? null,
      updatedAt: body.updatedAt,
    };
  }, [jobId]);

  const adoptServer = useCallback((row: StoredResume) => {
    assignBase(row.updatedAt);
    storeRow(row);
    if (!hostRef.current.playing()) hostRef.current.adopt(row);
  }, [assignBase, storeRow]);

  useLayoutEffect(() => {
  sendRef.current = async (snapshot, force, allowRetry) => {
    const expectedUpdatedAt = baseUpdatedAtRef.current;
    let response: Response;
    try {
      response = await fetch(`/api/jobs/${jobId}/position`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          positionSeconds: snapshot.positionSeconds,
          sectionIndex: snapshot.sectionIndex,
          expectedUpdatedAt,
          force,
        }),
        keepalive: true,
      });
    } catch {
      return;
    }
    if (response.status === 409) {
      let body: PositionPayload | null = null;
      try {
        body = (await response.json()) as PositionPayload;
      } catch {
        body = null;
      }
      let updatedAt = typeof body?.updatedAt === "number" ? body.updatedAt : null;
      let serverRow: StoredResume | null =
        updatedAt == null
          ? null
          : {
              positionSeconds: Number(body?.positionSeconds) || 0,
              sectionIndex: body?.sectionIndex ?? null,
              updatedAt,
            };
      if (!serverRow) {
        if (!allowRetry) return;
        serverRow = await readServer().catch(() => null);
        if (!serverRow) return;
        updatedAt = serverRow.updatedAt;
      }
      if (
        confirmedUpdatedAtRef.current != null &&
        serverRow.updatedAt < confirmedUpdatedAtRef.current
      ) {
        return;
      }
      assignBase(serverRow.updatedAt);
      const playing = hostRef.current.playing();
      const active = playing || movedSinceConfirmRef.current;
      if (active && allowRetry) {
        const live = hostRef.current.live();
        if (live && !samePlayhead(serverRow, live)) {
          await sendRef.current(live, force, false);
          return;
        }
        if (live) {
          storeRow({ ...live, updatedAt: serverRow.updatedAt });
          return;
        }
      }
      adoptServer(serverRow);
      return;
    }
    if (!response.ok) return;
    let body: { updatedAt?: number } = {};
    try {
      body = (await response.json()) as { updatedAt?: number };
    } catch {
      return;
    }
    if (typeof body.updatedAt !== "number") return;
    if (
      confirmedUpdatedAtRef.current != null &&
      body.updatedAt < confirmedUpdatedAtRef.current
    ) {
      return;
    }
    confirmedUpdatedAtRef.current = body.updatedAt;
    baseUpdatedAtRef.current = body.updatedAt;
    movedSinceConfirmRef.current = false;
    storeRow({
      positionSeconds: snapshot.positionSeconds,
      sectionIndex: snapshot.sectionIndex,
      updatedAt: body.updatedAt,
    });
  };
  }, [adoptServer, assignBase, jobId, readServer, storeRow]);

  const remember = useCallback(
    (snapshot: Playhead, reason: ResumeSaveReason) => {
      if (!enabled) return;
      const force = reason === "seek" || reason === "track";
      if (holdUnrestoredRef.current && !force) return;
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
      if (force) {
        movedRef.current = true;
        movedSinceConfirmRef.current = true;
      }
      if (!force && samePlayhead(lastSentRef.current, snapshot)) return;
      lastWriteRef.current = now;
      if (reason === "tick" && now - lastNetRef.current < RESUME_SAVE_INTERVAL_MS) return;
      lastNetRef.current = now;
      void sendRef.current(snapshot, force, true);
    },
    [enabled]
  );

  const noteServer = useCallback(
    (remote: StoredResume | null): StoredResume | null => {
      gateRef.current = false;
      const explicit = movedRef.current;
      if (!explicit) {
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
      if (remote) assignBase(remote.updatedAt);
      else if (current) assignBase(current.updatedAt);
      if (!explicit && remote && remote.positionSeconds > 0.05) {
        holdUnrestoredRef.current = true;
      }
      return current;
    },
    [assignBase, jobId]
  );

  /**
   * The job request failed. Saving may start. There is no server timestamp
   * to adopt here; the next write's 409 carries the row and becomes the base.
   */
  const noteServerFailed = useCallback(() => {
    gateRef.current = false;
  }, []);

  /**
   * Play after the server row is merged is a move, so a later response
   * does not rewind it. Play before that merge is not: the row still
   * has to land.
   */
  const markMoved = useCallback(() => {
    if (gateRef.current) return;
    movedRef.current = true;
  }, []);

  const releaseUnrestored = useCallback(() => {
    holdUnrestoredRef.current = false;
  }, []);

  const refreshFromServer = useCallback(async () => {
    if (!enabled || gateRef.current) return;
    if (hostRef.current.playing()) return;
    let remote: StoredResume | null = null;
    try {
      remote = await readServer();
    } catch {
      return;
    }
    if (!remote) return;
    if (hostRef.current.playing()) return;
    const base = baseUpdatedAtRef.current;
    if (base != null && remote.updatedAt <= base) return;
    adoptServer(remote);
  }, [adoptServer, enabled, readServer]);

  const bindHost = useCallback((host: ResumeHost) => {
    hostRef.current = host;
  }, []);

  return {
    savedRef,
    movedRef,
    remember,
    noteServer,
    noteServerFailed,
    markMoved,
    releaseUnrestored,
    refreshFromServer,
    bindHost,
  };
}
