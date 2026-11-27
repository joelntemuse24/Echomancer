"use client";

import { ArrowLeft, Loader2, List } from "lucide-react";
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { playbackForResume } from "@/lib/nav/cached-playback";
import { detailFailureIsFinal } from "@/lib/nav/detail-failure";
import { useClientSearchParams } from "@/lib/nav/client-search";
import { playerIdFromPathname } from "@/lib/nav/player-path";
import { LIBRARY_HREF, PREFETCH_SCREEN } from "@/lib/nav/routes";
import {
  SCREEN_JOBS,
  forgetJob,
  invalidateScreen,
  peekJob,
  rememberJobDetail,
} from "@/lib/nav/screen-cache";
import { useAudioProcessor } from "@/hooks/useAudioProcessor";
import { usePlayback } from "@/components/playback-provider";
import { customerBookStatus, userFriendlyError } from "@/lib/errors-ui";
import {
  mediaSessionActive,
  partRowCanPlay,
  partRowLabel,
  playbackAllowed,
  playbackUrlForStatus,
  playerShowsPlay,
} from "@/lib/library/card-play";import { EditableBookTitle } from "@/components/editable-book-title";
import { bookTitleHeadingClass } from "@/lib/book-title";
import { cn } from "@/lib/utils";
import { playerStatusLine, UX } from "@/lib/ux-copy";
import { useSmoothedEtaLabel } from "@/hooks/use-smoothed-eta";
import {
  audiobookDownloadUrl,
  audiobookFilename,
  isIosDownload,
  startAudiobookDownload,
} from "@/lib/download-client";
import { JOB_POLL_MIN_MS, nextJobPollDelay, shouldPollJob } from "@/lib/player/poll-schedule";
import { advanceAfterSection, continuePastPublishedPrefix, readySnapshotHandoff } from "@/lib/player/section-advance";
import { growingFileDuration } from "@/lib/player/growing-file";
import { chooseLivePart, liveAttachResumeAt, liveChapterSeek, liveEdgeSeconds, liveReadyTransition, restoreLiveEdge, seekTargetIfCovered } from "@/lib/player/live-playlist";
import { liveAttachToken, liveBufferedSeconds, liveSessionAttached, releaseLiveSession, retargetLiveResume, setLivePlayIntent, syncLivePlayback } from "@/lib/player/live-session";
import { acceptJobPoll, commitUserStop, generationStatus } from "@/lib/player/generation-status";
import { nextPlayableIndex } from "@/lib/tts/section-index";
import { shouldReloadStorageAfterError } from "@/lib/player/storage-reload";
import {
  cacheBustPlaybackUrl,
  playbackRecoveryCount,
  withPlaybackGrant,
  versionedAudioUrl,
} from "@/lib/player/playback-url";
import { createTranscriptResource, transcriptRevision } from "@/lib/player/transcript-resource";
import { charIndexForPlayback, passageSeekForChar, sectionHandoffSeconds, sectionSeekSeconds } from "@/lib/player/read-along";
import {
  newStreamConn,
  streamClockDocument,
  streamCoveredSeconds,
  streamUrlWithConn,
  timelineMatchesConn,
  type StreamTimeline,
} from "@/lib/player/stream-clock";
import { clampSeekSeconds, seekableDuration } from "@/lib/player/seek";
import { useAudioStart } from "@/hooks/use-audio-start";
import {
  elementIsPlaying,
  partIndexForSrc,
  samePlaybackSource,
} from "@/lib/player/element-playback";
import {
  prepareChapterView,
  mediaSessionFields,
  type PlayerChapter,
} from "@/lib/player/chapter-nav";
import { PlayerSeekGroup } from "@/components/player-seek-group";
import { PlayerSpeedControl } from "@/components/player-speed-control";
import { assignPlaybackRate } from "@/lib/player/playback-speed";
import { PlayerTransport } from "@/components/player-transport";
import {
  NowPlayingLine,
  PlayerChapterSheet,
  useChapterListOpen,
} from "@/components/player-chapter-sheet";
import { ReadAlongTranscript } from "@/components/read-along-transcript";
import { ReadAlongFocus } from "@/components/read-along-focus";
import { PlayerBookmarks } from "@/components/player-bookmarks";
import { useReadAlongFocus } from "@/hooks/use-read-along-focus";
import { useJobBookmarks } from "@/hooks/use-job-bookmarks";
import { usePlaybackResume } from "@/hooks/use-playback-resume";
import { type JobBookmark } from "@/lib/player/bookmarks";
import {
  RESUME_SAVE_INTERVAL_MS,
  absoluteBookmarkSeconds,
  availableBookSeconds,
  bookTimeFromElement,
  elementClockOffset,
  bookmarkClockLabel,
  bookmarkOnAbsoluteClock,
  placeOnTimeline,
  positionToPersist,
  resumeTickAllowed,
  sectionBookSpans,
  sectionFileSeconds,
  sectionOnBookClock,
  snapshotForPersist,
  withPinnedStart,
  shouldApplyDetailSeek,
  sortBookmarksByClock,
  type ResumeSaveReason,
  type SectionSpan,
  type StoredResume,
} from "@/lib/player/playback-position";
import { usePreciseSeek } from "@/hooks/use-precise-seek";
import type { ReadAlongDocument, ReadAlongMode, ReadAlongPosition } from "@/lib/player/read-along";

function readyByIndex(
  segments: Array<{ index: number; path: string; status: string }> | null | undefined
): Map<number, { index: number; path: string; status: string }> {
  const map = new Map<number, { index: number; path: string; status: string }>();
  for (const s of segments || []) {
    if (s.status === "ready" && s.path) map.set(s.index, s);
  }
  return map;
}

/**
 * Next section to advance to, using the shared rule.
 *
 * The player used to hold its own copy of this: advance only when every earlier
 * index was ready. On a finished book with a hole that stranded every remaining
 * section behind one that would never render, so the shared helper takes the
 * job status into account (`job 1f0137a1`).
 */
function nextIndexAfter(
  segments: Array<{ index: number; path: string; status: string }> | null | undefined,
  from: number,
  jobStatus: string | undefined
): number | null {
  return nextPlayableIndex((segments ?? []) as never, from, {
    skipUnavailable: jobStatus === "ready",
  });
}

/** Anything the listener can hear yet: a section file or the assembled book. */
function hasPlayableAudio(job: Job | null | undefined): boolean {
  if (!job) return false;
  if (job.audio_url) return true;
  return (job.segments || []).some((segment) => Boolean(segment.path));
}

/** Live stream: budget/status only. */
const STREAM_POLL_MS = 10_000;
/** Live stream with the transcript open: pick up measured window lengths quickly. */
const STREAM_SYNC_POLL_MS = 3_000;
/** Poll for the next window length when the playhead is this close to the end of the known ones. */
const STREAM_LENGTH_LEAD_SECONDS = 8;
/** Playback seconds a reconnected stream may keep the previous passage highlighted. */
const STREAM_HOLD_SECONDS = 20;
/** Give up on the fast interval after this many polls without news. */
const STREAM_SYNC_IDLE_POLLS = 5;
/** Ready books: refresh the presigned download link well inside its 12–13h life. */
const DOWNLOAD_URL_REFRESH_MS = 30 * 60 * 1000;

interface Job {
  id: string;
  book_title: string;
  voice_name: string | null;
  status: "queued" | "waiting" | "processing" | "ready" | "failed" | "cancelled";
  progress: number;
  current_section: number;
  total_sections: number;
  audio_url?: string | null;
  /** Presigned R2 attachment link for a finished book (see direct-download.ts). */
  download_url?: string;
  duration_seconds: number | null;
  error_message: string | null;
  warning?: string | null;
  /** Take-home created while its upload was still extracting. */
  waiting_for_text?: boolean;
  created_at: string;
  updated_at: string;
  job_kind?: string | null;
  tts_provider?: string | null;
  stream_url?: string;
  segments?: Array<{
    index: number;
    path: string;
    status: string;
    durationSeconds?: number | null;
  }> | null;
  resume_position_seconds?: number | null;
  resume_section_index?: number | null;
  resume_updated_at?: number | null;
  chapters?: PlayerChapter[] | null;
  stream_chars_used?: number | null;
  stream_max_chars?: number | null;
  stream_cursor?: number | null;
  stream_timeline?: StreamTimeline | null;
  /** Server-owned estimate; the library card shows this same label. */
  eta_seconds?: number | null;
  eta_label?: string | null;
  catalog_voice_id?: string | null;
  first_section_at?: number | null;
  eta_state?: "estimating" | "live" | "finalizing" | "done" | null;
  playback_grant?: string | null;
}

function PlayerLoadingShell() {
  return (
    <div className="mx-auto w-full max-w-3xl pt-8 pb-20 font-sans" aria-busy="true">
      <Link
        href={LIBRARY_HREF}
        prefetch={PREFETCH_SCREEN}
        className="tap mb-8 inline-flex items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        Library
      </Link>
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading</span>
      </div>
    </div>
  );
}

export default function PlayerPage() {
  const id = playerIdFromPathname(usePathname());
  if (!id) return <PlayerLoadingShell />;
  return <PlayerPageInner id={id} />;
}

type PendingChapterSeek = {
  seconds: number | null;
  fraction: number;
  charIndex?: number;
  document?: ReadAlongDocument;
  bookSeconds?: number | null;
  sectionIndex?: number | null;
};

/**
 * A pending seek that metadata can already apply, and still has not,
 * must not block later saves. The clock stays off while the element is
 * HAVE_NOTHING: a slow file has not failed to seek, it has not started.
 */
const PENDING_SEEK_LIMIT_MS = 12_000;

function PlayerPageInner({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useClientSearchParams();
  const forceStream = searchParams.get("mode") === "stream";
  const forceSegments = searchParams.get("mode") === "segments";
  /**
   * `playing` is the shared element's own state, and the page's only source for
   * the transport icon.
   *
   * This page unmounts on navigation while the root-layout element keeps
   * playing, and a book that never stopped fires no `play` event. A local
   * `useState(false)` therefore came back showing Play over playing audio, and
   * its tap called `play()` on an already-playing element, which resolves
   * without doing anything — the button looked dead.
   */
  const {
    audioRef,
    playing: isPlaying,
    setSource,
    releaseForJob,
    reportSession,
    detachSession,
  } = usePlayback();
  const processorInitialized = useRef(false);

  const [job, setJob] = useState<Job | null>(() => peekJob<Job>(id));
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  audioUrlRef.current = audioUrl;
  const [isDragging, setIsDragging] = useState(false);
  const [segmentIndex, setSegmentIndex] = useState(0);
  const segmentIndexRef = useRef(0);
  const [spawningTakehome, setSpawningTakehome] = useState(false);
  const [streamEnded, setStreamEnded] = useState(false);
  /** Id of the current stream connection; its audio timeline starts at 0. */
  const [streamConn, setStreamConn] = useState<string | null>(null);
  /** Set while the open transcript is waiting on window lengths. */
  /** Passage on screen when the last stream connection ended. */
  const [heldStreamChar, setHeldStreamChar] = useState<number | null>(null);
  const streamCharRef = useRef<number | null>(null);
  const streamFastPollRef = useRef(false);
  const streamIdlePollsRef = useRef(0);
  /** Last playback or action problem, shown quietly under the title. */
  const [notice, setNotice] = useState<string | null>(null);
  const [showSections, setShowSections] = useState(false);
  /**
   * Precise seek is a disclosure, remembered between visits. Off by
   * default: the main bar is what a listener reaches for.
   */
  const { preciseSeek, setPreciseSeek } = usePreciseSeek();
  const [showTranscript, setShowTranscript] = useState(false);
  /** Read-along fills the viewport with its own slim player bar. */
  const { focus: focusTranscript, setFocus: setFocusTranscript } = useReadAlongFocus();
  const jobBookmarks = useJobBookmarks(id);
  const [transcript, setTranscript] = useState<ReadAlongDocument | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState(false);
  const [transcriptRetry, setTranscriptRetry] = useState(0);
  const transcriptResource = useMemo(() => createTranscriptResource(id), [id]);
  const revision = useMemo(() => job ? transcriptRevision(job) : "", [job]);
  const playAfterLoadRef = useRef(false);
  /**
   * Seek to apply once the file's metadata is loaded.
   * `bookSeconds` is the absolute time that seek stands for, so a source
   * change that resets the element can store that time instead of 0.
   */
  const pendingChapterSeekRef = useRef<PendingChapterSeek | null>(null);
  const pendingSeekTimerRef = useRef<number | null>(null);
  /**
   * The expiry dropped a target that was not the start of the file.
   * Ticks stay quiet until the listener seeks or playback moves on from
   * a position this tab already confirmed.
   */
  const droppedSeekHoldRef = useRef(false);
  /** Element time last accepted by a landed seek or by playback itself. */
  const confirmedPlayheadRef = useRef<number | null>(null);
  const seenAudioUrlRef = useRef<string | null>(null);
  const clearPendingSeekRef = useRef<() => void>(() => {});
  const armPendingSeekRef = useRef<(value: PendingChapterSeek) => void>(() => {});
  const ensurePendingExpiryRef = useRef<() => void>(() => {});
  clearPendingSeekRef.current = () => {
    pendingChapterSeekRef.current = null;
    if (pendingSeekTimerRef.current != null) {
      window.clearTimeout(pendingSeekTimerRef.current);
      pendingSeekTimerRef.current = null;
    }
  };
  ensurePendingExpiryRef.current = () => {
    const pending = pendingChapterSeekRef.current;
    if (!pending || pendingSeekTimerRef.current != null) return;
    const audio = audioRef.current;
    if (!audio || audio.readyState < 1) return;
    pendingSeekTimerRef.current = window.setTimeout(() => {
      pendingSeekTimerRef.current = null;
      if (pendingChapterSeekRef.current !== pending) return;
      const now = audioRef.current;
      if (!now || now.readyState < 1) return;
      const book = pending.bookSeconds;
      const seconds = pending.seconds;
      const knownStart =
        (book == null || book <= 0.05) &&
        (seconds == null || seconds <= 0.05) &&
        pending.fraction <= 0.001;
      pendingChapterSeekRef.current = null;
      if (!knownStart) droppedSeekHoldRef.current = true;
    }, PENDING_SEEK_LIMIT_MS);
  };
  armPendingSeekRef.current = (value) => {
    pendingChapterSeekRef.current = value;
    if (typeof value.bookSeconds === "number" && value.bookSeconds > 0.05) {
      confirmedPlayheadRef.current = value.bookSeconds;
    }
    droppedSeekHoldRef.current = false;
    if (pendingSeekTimerRef.current != null) {
      window.clearTimeout(pendingSeekTimerRef.current);
      pendingSeekTimerRef.current = null;
    }
    ensurePendingExpiryRef.current();
  };
  useEffect(() => () => {
    if (pendingSeekTimerRef.current != null) window.clearTimeout(pendingSeekTimerRef.current);
  }, []);
  /** Last seek this page asked for, so a reload never returns to the old spot. */
  const lastRequestedSeekRef = useRef<number | null>(null);
  const waitingForNextRef = useRef(false);
  /** Start of the section file now playing. A later hole measurement does not move it. */
  const [pinnedStart, setPinnedStart] = useState<{ index: number; start: number } | null>(null);
  /** Play at the generated edge. A restart that slips backward is put back. */
  const edgeHoldRef = useRef<number | null>(null);
  const storageReloadRef = useRef(0);
  const heardPlayingRef = useRef(false);
  /**
   * This visit found the shell already on this book with a real playhead
   * (playing, past the start, or on a later part). The detail response must
   * not move that element: the stored row is behind a listen that never stopped.
   */
  const adoptedLiveRef = useRef(false);
  /** True only after the listener pauses. Running off the buffer leaves it false. */
  const listenerPausedRef = useRef(false);

  // Reset the page chrome when the book id changes. The playhead itself is
  // restored by the layout effect, which runs before this and before paint.
  useEffect(() => {
    setJob(peekJob<Job>(id));
    setTranscript(null);
    setTranscriptError(false);
    setShowTranscript(false);
    // Focus mode is a remembered preference, so a different book keeps it.
    waitingForNextRef.current = false;
    setPinnedStart(null);
    setStreamConn(null);
    setHeldStreamChar(null);
    setError(null);
    processorInitialized.current = false;
  }, [id]);

  // Use ref for isDragging to avoid effect re-registration
  const isDraggingRef = useRef(false);
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  const { initialize, resume, setSpeed, speed } = useAudioProcessor();

  const { start: startAudio, stop: stopAudio, settle: settleAudioStart, reset: resetAudioStart } =
    useAudioStart({
      audioRef,
      playAfterLoadRef,
      pendingSeekRef: pendingChapterSeekRef,
      onNotice: setNotice,
      resume,
    });

  const openStreamUrl = useCallback((base: string) => {
    const conn = newStreamConn();
    setStreamConn(conn);
    return streamUrlWithConn(base, conn);
  }, []);

  const resumeEnabled =
    playbackAllowed(job?.status) && job?.job_kind !== "stream" && !forceStream;
  const playbackResume = usePlaybackResume(id, resumeEnabled);
  const spans = useMemo(
    () => withPinnedStart(sectionBookSpans(job?.segments ?? []), pinnedStart),
    [job?.segments, pinnedStart]
  );
  const spansRef = useRef<SectionSpan[]>([]);
  spansRef.current = spans;
  const [scrubBookTime, setScrubBookTime] = useState<number | null>(null);
  const captureRef = useRef<(reason: ResumeSaveReason) => void>(() => {});
  const markMovedRef = useRef<() => void>(() => {});
  markMovedRef.current = playbackResume.markMoved;
  const refreshResumeRef = useRef<() => Promise<void>>(async () => {});
  const livePlayheadRef = useRef<
    () => { positionSeconds: number; sectionIndex: number | null } | null
  >(() => null);
  const adoptResumeRef = useRef<(row: StoredResume) => void>(() => {});
  refreshResumeRef.current = () => playbackResume.refreshFromServer();
  playbackResume.bindHost({
    playing: () => Boolean(audioRef.current && !audioRef.current.paused),
    live: () => livePlayheadRef.current(),
    adopt: (row) => adoptResumeRef.current(row),
  });
  adoptResumeRef.current = (row) => {
    const audio = audioRef.current;
    const onSection = Boolean(audioUrlRef.current?.includes("/sections/"));
    let local = row.positionSeconds;
    let targetSection = row.sectionIndex;
    if (onSection && row.sectionIndex == null) {
      const place = placeOnTimeline({
        bookSeconds: row.positionSeconds,
        spans: spansRef.current,
      });
      if (place) {
        local = place.localSeconds;
        targetSection = place.sectionIndex;
      }
    }
    const fileMatches = !onSection || targetSection === segmentIndexRef.current;
    if (audio && audio.readyState >= 1 && fileMatches) {
      clearPendingSeekRef.current();
      audio.currentTime = local;
      setCurrentTime(local);
      confirmedPlayheadRef.current = local;
      if (local > 0.5) restoreLandedRef.current = true;
      return;
    }
    armPendingSeekRef.current({
      seconds: local,
      fraction: 0,
      bookSeconds: row.sectionIndex == null ? row.positionSeconds : null,
      sectionIndex: targetSection,
    });
  };
  /** A real playhead has been heard. A load that reports 0 is not one. */
  const restoreLandedRef = useRef(false);

  const armPlayback = (
    seeded: { url: string; segmentIndex: number | null; localSeconds: number; restart?: boolean } | null,
    status: string | null | undefined
  ) => {
    if (!seeded) return;
    const url = playbackUrlForStatus(status, seeded.url);
    if (!url) return;
    if (seeded.restart) {
      playbackResume.remember({ positionSeconds: 0, sectionIndex: null }, "seek");
    }
    if (seeded.localSeconds > 0.05) {
      const onSection = seeded.segmentIndex != null;
      const mapped = onSection
        ? bookTimeFromElement({
            mode: "section",
            elementSeconds: seeded.localSeconds,
            sectionIndex: seeded.segmentIndex,
            spans: spansRef.current,
          })
        : { seconds: seeded.localSeconds, absolute: true };
      armPendingSeekRef.current({
        seconds: seeded.localSeconds,
        fraction: 0,
        bookSeconds: mapped.absolute ? mapped.seconds : null,
        sectionIndex: seeded.segmentIndex,
      });
      playAfterLoadRef.current = false;
      setCurrentTime(seeded.localSeconds);
    }
    if (seeded.segmentIndex != null) setSegmentIndex(seeded.segmentIndex);
    setAudioUrl(url);
  };

  // Local resume runs before paint so a refresh does not flash 0:00.
  // The hook's layout effect has already filled savedRef. savedRef is a ref;
  // re-running when the callback identity changes would seek again after the
  // listener has already moved.
  useLayoutEffect(() => {
    restoreLandedRef.current = false;
    adoptedLiveRef.current = false;
    const cached = peekJob<Job>(id);
    if (liveSessionAttached(audioRef.current)) return;
    const seeded = playbackForResume(cached, playbackResume.savedRef.current, {
      forceStream,
      forceSegments,
    });
    if (!seeded) {
      clearPendingSeekRef.current();
      setCurrentTime(0);
      setSegmentIndex(0);
      setAudioUrl(null);
      // This page does not pause the shared element. A book whose status
      // forbids playback releases it (the effect below), and a book that is
      // merely not seeded yet has nothing of its own to stop.
      return;
    }
    // Returning to a book the shell still holds: the element is the truth.
    // The stored row is up to one save interval behind, and the page has just
    // remounted with nothing of its own, so seeking to that row would rewind a
    // listen that never stopped. A cache-busting `?r=n` on the element, and an
    // absolute attribute the browser stored for the same path, are still the
    // same file.
    const live = audioRef.current;
    const elementSrc = live?.getAttribute("src") ?? "";
    // Which part is the element holding? A part book's resume seed always
    // names part 0, but the shell may have advanced to a later part while no
    // page was mounted. Comparing only against the seed would call that a
    // different book and re-point the element at part 0, restarting the file.
    const heldPart = partIndexForSrc(
      (cached?.segments ?? []).map((segment) => ({
        index: segment.index,
        url: `/api/storage/${segment.path}`,
      })),
      elementSrc
    );
    const sameFile = samePlaybackSource(elementSrc, seeded.url) || heldPart != null;
    if (live && sameFile) {
      const at = Number.isFinite(live.currentTime) ? live.currentTime : 0;
      // A later part is a move the seed did not see, even when its clock is
      // still 0 because the shell just handed the file off.
      const differentPart = heldPart != null && heldPart !== seeded.segmentIndex;
      // Playing, or already past the start: do not apply the stored row.
      // Paused on this same file at the start still takes the resume seek,
      // and it keeps the element's own URL so a `?r=` is not stripped.
      const trustLive = elementIsPlaying(live) || at > 0.5 || differentPart;
      setSegmentIndex(heldPart ?? seeded.segmentIndex ?? 0);
      seenAudioUrlRef.current = elementSrc;
      setAudioUrl(elementSrc);
      if (Number.isFinite(live.duration) && live.duration > 0) setDuration(live.duration);
      if (trustLive) {
        adoptedLiveRef.current = true;
        clearPendingSeekRef.current();
        setCurrentTime(at);
        confirmedPlayheadRef.current = at;
        if (at > 0.5) restoreLandedRef.current = true;
        return;
      }
      if (seeded.restart) {
        playbackResume.remember({ positionSeconds: 0, sectionIndex: null }, "seek");
      }
      if (seeded.localSeconds > 0.05) {
        const onSection = seeded.segmentIndex != null;
        const mapped = onSection
          ? bookTimeFromElement({
              mode: "section",
              elementSeconds: seeded.localSeconds,
              sectionIndex: seeded.segmentIndex,
              spans: spansRef.current,
            })
          : { seconds: seeded.localSeconds, absolute: true as const };
        armPendingSeekRef.current({
          seconds: seeded.localSeconds,
          fraction: 0,
          bookSeconds: mapped.absolute ? mapped.seconds : null,
          sectionIndex: seeded.segmentIndex,
        });
        playAfterLoadRef.current = false;
        setCurrentTime(seeded.localSeconds);
      } else {
        clearPendingSeekRef.current();
        setCurrentTime(at);
      }
      return;
    }
    armPlayback(seeded, cached?.status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, forceStream, forceSegments]);

  // Fetch job data via REST API. A library row already on screen starts
  // its file now; the detail request fills chapters in behind it. A network
  // or server failure keeps that row and says so. 401, 403, and 404 clear
  // it: the book is gone, and a seeded file with no explanation is worse.
  // The server copy is applied once per book. An explicit seek is kept.
  // Play before the row arrives still takes a newer server time.
  useEffect(() => {
    let stopped = false;
    async function fetchJob() {
      try {
        const response = await fetch(`/api/jobs/${id}`);
        if (!response.ok) {
          if (!stopped) playbackResume.noteServerFailed();
          if (detailFailureIsFinal(response.status)) {
            forgetJob(id);
            if (stopped) return;
            setJob(null);
            setAudioUrl(null);
            setError("Couldn't load this audiobook.");
            return;
          }
          throw new Error(String(response.status));
        }
        const data = await response.json();
        const j = data.job as Job;
        rememberJobDetail(id, { job: j });
        if (stopped) return;
        setJob(j);
        if (!playbackAllowed(j.status)) {
          setAudioUrl(null);
          return;
        }

        const isStream = forceStream || j.job_kind === "stream";
        if (isStream) {
          setAudioUrl(openStreamUrl(j.stream_url || `/api/jobs/${id}/stream`));
          return;
        }

        const remote =
          typeof j.resume_position_seconds === "number"
            ? {
                positionSeconds: j.resume_position_seconds,
                sectionIndex: j.resume_section_index ?? null,
                updatedAt: j.resume_updated_at ?? 0,
              }
            : null;
        const localUpdated = playbackResume.savedRef.current?.updatedAt ?? null;
        const explicit = playbackResume.movedRef.current;
        const chosen = playbackResume.noteServer(remote);
        try {
        const next = playbackForResume(j, chosen, { forceStream, forceSegments });
        if (liveSessionAttached(audioRef.current)) return;
        if (!next) return;
        // The shell was already on this book. A newer server row must not
        // rewind or re-point an element the listener is hearing.
        if (adoptedLiveRef.current) return;
        if (!audioUrlRef.current) {
          armPlayback(next, j.status);
          return;
        }
        const audio = audioRef.current;
        const sameFile =
          audioUrlRef.current != null &&
          audioUrlRef.current.split("?")[0] === next.url.split("?")[0];
        const elementOnSection = Boolean(audioUrlRef.current?.includes("/sections/"));
        const elementMapped = bookTimeFromElement({
          mode: elementOnSection ? "section" : "full",
          elementSeconds: audio?.currentTime ?? 0,
          sectionIndex: elementOnSection ? segmentIndexRef.current : null,
          spans: spansRef.current,
        });
        const targetMapped =
          next.segmentIndex == null
            ? { seconds: next.localSeconds, absolute: true }
            : bookTimeFromElement({
                mode: "section",
                elementSeconds: next.localSeconds,
                sectionIndex: next.segmentIndex,
                spans: spansRef.current,
              });
        const comparable = sameFile || (elementMapped.absolute && targetMapped.absolute);
        const elementSeconds = sameFile
          ? (audio?.currentTime ?? 0)
          : comparable
            ? elementMapped.seconds
            : 0;
        const targetSeconds = sameFile
          ? next.localSeconds
          : comparable
            ? targetMapped.seconds
            : next.localSeconds;
        const wasPlaying = Boolean(audio && !audio.paused);
        const serverNewer =
          remote != null && (localUpdated == null || remote.updatedAt > localUpdated);
        if (
          !shouldApplyDetailSeek({
            explicitSeek: explicit,
            playing: wasPlaying,
            elementSeconds,
            targetSeconds,
            serverNewer,
          })
        ) {
          return;
        }
        if (sameFile) {
          if (audio && audio.readyState >= 1) {
            clearPendingSeekRef.current();
            lastRequestedSeekRef.current = next.localSeconds;
            audio.currentTime = next.localSeconds;
            setCurrentTime(next.localSeconds);
            confirmedPlayheadRef.current = next.localSeconds;
            if (next.localSeconds > 0.5) restoreLandedRef.current = true;
            if (wasPlaying && audio.paused) void audio.play().catch(() => {});
          } else {
            armPendingSeekRef.current({
              seconds: next.localSeconds,
              fraction: 0,
              bookSeconds: targetMapped.absolute ? targetMapped.seconds : null,
              sectionIndex: next.segmentIndex,
            });
            playAfterLoadRef.current = wasPlaying;
            setCurrentTime(next.localSeconds);
          }
          return;
        }
        if (wasPlaying) playAfterLoadRef.current = true;
        armPlayback(next, j.status);
        } finally {
          playbackResume.releaseUnrestored();
        }
      } catch (err) {
        if (stopped) return;
        playbackResume.noteServerFailed();
        console.error("Failed to fetch job:", err);
        if (!peekJob(id)) setError("Couldn't load this audiobook.");
        else setNotice("Couldn't load this audiobook.");
      }
    }

    void fetchJob();
    return () => { stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, forceStream, forceSegments, openStreamUrl]);

  useEffect(() => { audioUrlRef.current = audioUrl; }, [audioUrl]);

  // Polling for updates (adaptive, see below) - only re-render if data actually changed
  const jobRef = useRef<Job | null>(null);
  useEffect(() => { jobRef.current = job; }, [job]);
  const pinSection = (index: number, start: number) => {
    if (!Number.isInteger(index) || index < 0 || !Number.isFinite(start)) return;
    const pin = { index, start: Math.max(0, start) };
    spansRef.current = withPinnedStart(sectionBookSpans(jobRef.current?.segments ?? []), pin);
    setPinnedStart(pin);
  };
  const readSnapshot = (reason: ResumeSaveReason) => {
    const audio = audioRef.current;
    const onSection = Boolean(audioUrlRef.current?.includes("/sections/"));
    const sectionIndex = onSection ? segmentIndexRef.current : null;
    const pending = pendingChapterSeekRef.current;
    const current = jobRef.current;
    const rawTime = audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const currentTime = onSection
      ? sectionFileSeconds({
          elementSeconds: rawTime,
          elementDuration: audio && Number.isFinite(audio.duration) ? audio.duration : 0,
          ended: Boolean(audio?.ended),
        })
      : rawTime;
    return snapshotForPersist({
      reason,
      currentTime,
      readyState: audio?.readyState ?? 0,
      ended: Boolean(audio?.ended),
      pendingActive: pending != null,
      pendingBookSeconds:
        typeof pending?.bookSeconds === "number" ? pending.bookSeconds : null,
      restoreLanded: restoreLandedRef.current,
      droppedSeek: droppedSeekHoldRef.current,
      confirmedSeconds: confirmedPlayheadRef.current,
      confirmedBookSeconds: confirmedPlayheadRef.current,
      onSection,
      sectionIndex,
      spans: spansRef.current,
      complete: current?.status === "ready",
      durationSeconds:
        typeof current?.duration_seconds === "number" ? current.duration_seconds : null,
      hasNextSection:
        onSection &&
        nextIndexAfter(current?.segments, segmentIndexRef.current, current?.status) != null,
    });
  };
  livePlayheadRef.current = () => readSnapshot("tick");
  captureRef.current = (reason) => {
    if (!resumeEnabled) return;
    const stored = readSnapshot(reason);
    if (!stored) return;
    playbackResume.remember(stored, reason);
  };
  const rememberBookRef = useRef<
    (bookSeconds: number, reason: ResumeSaveReason, sectionIndex: number | null) => void
  >(() => {});
  rememberBookRef.current = (bookSeconds, reason, sectionIndex) => {
    if (!resumeEnabled) return;
    const current = jobRef.current;
    const stored = positionToPersist({
      bookSeconds,
      durationSeconds:
        typeof current?.duration_seconds === "number" ? current.duration_seconds : null,
      complete: current?.status === "ready",
      ended: false,
    });
    if (bookSeconds > 0.5) restoreLandedRef.current = true;
    confirmedPlayheadRef.current = bookSeconds;
    droppedSeekHoldRef.current = false;
    const index = stored.finished ? null : sectionIndex;
    let positionSeconds = stored.positionSeconds;
    if (index != null) {
      const span = spansRef.current.find((item) => item.index === index);
      const local = span ? bookSeconds - span.startSeconds : 0;
      positionSeconds = Math.max(0, local);
    }
    playbackResume.remember({ positionSeconds, sectionIndex: index }, reason);
  };

  useEffect(() => {
    if (!resumeEnabled) return;
    let timer: number | null = null;
    const sync = () => {
      if (timer != null) window.clearInterval(timer);
      timer = null;
      const audio = audioRef.current;
      if (
        !resumeTickAllowed({
          playing: Boolean(audio && !audio.paused),
          hidden: document.visibilityState === "hidden",
        })
      ) {
        return;
      }
      timer = window.setInterval(() => captureRef.current("tick"), RESUME_SAVE_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        captureRef.current("hide");
        sync();
        return;
      }
      void refreshResumeRef.current().finally(sync);
    };
    const hide = () => captureRef.current("hide");
    const audio = audioRef.current;
    sync();
    audio?.addEventListener("play", sync);
    audio?.addEventListener("pause", sync);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", hide);
    window.addEventListener("beforeunload", hide);
    return () => {
      if (timer != null) window.clearInterval(timer);
      audio?.removeEventListener("play", sync);
      audio?.removeEventListener("pause", sync);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("beforeunload", hide);
    };
  }, [resumeEnabled, id, audioUrl, audioRef]);
  useEffect(() => { segmentIndexRef.current = segmentIndex; }, [segmentIndex]);

  const jobStatus = job?.status;
  const jobKind = job?.job_kind;
  useEffect(() => {
    if (playbackAllowed(jobStatus)) return;
    if (jobStatus !== "failed") return;
    if (audioUrl != null) setAudioUrl(null);
  }, [jobStatus, audioUrl]);
  // Opening a file that just became ready uses the same resume seed.
  useEffect(() => {
    if (!jobStatus) return;
    const isStream = forceStream || jobKind === "stream";
    // Poll take-home while generating; also poll streams for budget/status.
    const finished =
      jobStatus === "ready" && (forceSegments || Boolean(job?.audio_url));
    if (
      !isStream &&
      (jobStatus === "failed" || jobStatus === "cancelled" || finished)
    ) {
      return;
    }

    // Each poll is a Vercel invocation. A live stream only needs its budget
    // now and then; a generating book stays brisk until the first audio is
    // playable, then backs off while nothing changes. A hidden tab does not
    // poll unless audio is playing or the next section has not arrived yet,
    // and it polls on return.
    let delay = isStream ? STREAM_POLL_MS : JOB_POLL_MIN_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      const fastStream =
        streamFastPollRef.current && streamIdlePollsRef.current < STREAM_SYNC_IDLE_POLLS;
      timer = setTimeout(tick, isStream ? (fastStream ? STREAM_SYNC_POLL_MS : STREAM_POLL_MS) : delay);
    };

    const tick = async () => {
      if (stopped) return;
      try {
      const media = audioRef.current;
      if (
        typeof document !== "undefined" &&
        !shouldPollJob({
          visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
          playing: Boolean(media && !media.paused && !media.ended),
          waitingForNext: waitingForNextRef.current,
        })
      ) {
        return;
      }
      const changed = await poll();
      if (isStream) {
        streamIdlePollsRef.current = changed ? 0 : streamIdlePollsRef.current + 1;
      } else {
        const atEnd =
          Boolean(media && media.duration > 0 && media.currentTime >= media.duration - 1.5) &&
          Boolean(audioUrlRef.current) &&
          !audioUrlRef.current!.includes("/sections/") &&
          jobRef.current?.status !== "ready";
        delay = nextJobPollDelay({
          delay,
          changed,
          hasPlayableAudio: hasPlayableAudio(jobRef.current),
          waitingAtGap: waitingForNextRef.current || atEnd,
          urgent:
            generationStatus({
              status: jobRef.current?.status ?? "processing",
              currentSection: jobRef.current?.current_section,
              totalSections: jobRef.current?.total_sections,
              segments: jobRef.current?.segments,
              etaLabel: jobRef.current?.eta_label,
              etaState: jobRef.current?.eta_state,
              waitingForText: jobRef.current?.waiting_for_text,
              provider: jobRef.current?.tts_provider,
            }).phase === "finishing",
        });
      }
      } finally {
        if (!stopped) schedule();
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        delay = isStream ? STREAM_POLL_MS : JOB_POLL_MIN_MS;
        void tick();
      }
    };

    /** One poll. Returns whether the job changed. */
    const poll = async (): Promise<boolean> => {
      let changed = false;
      try {
        const response = await fetch(`/api/jobs/${id}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) return false;
        const data = await response.json();
        if (stopped) return false;
        const prev = jobRef.current;
        const next = data.job as Job;
        if (!acceptJobPoll(prev?.status, next.status)) return false;

        if (!prev ||
            prev.status !== next.status ||
            prev.progress !== next.progress ||
            prev.current_section !== next.current_section ||
            prev.total_sections !== next.total_sections ||
            prev.audio_url !== next.audio_url ||
            prev.error_message !== next.error_message ||
            prev.duration_seconds !== next.duration_seconds ||
            prev.waiting_for_text !== next.waiting_for_text ||
            prev.stream_chars_used !== next.stream_chars_used ||
            prev.stream_max_chars !== next.stream_max_chars ||
            prev.stream_cursor !== next.stream_cursor ||
            // The display string, not the raw seconds: eta_seconds ticks on
            // every poll and would pin the Vercel poll backoff at its minimum.
            prev.eta_label !== next.eta_label ||
            prev.eta_state !== next.eta_state ||
            JSON.stringify(prev.stream_timeline) !== JSON.stringify(next.stream_timeline) ||
            JSON.stringify(prev.segments) !== JSON.stringify(next.segments) ||
            JSON.stringify(prev.chapters) !== JSON.stringify(next.chapters)) {
          changed = true;
          // Keep the ref current before the render effect runs: the delay
          // decision below reads it right after this poll returns.
          jobRef.current = next;
          setJob(next);
        }

        if (isStream) {
          const used = next.stream_chars_used ?? 0;
          const max = next.stream_max_chars ?? 0;
          if (max > 0 && used >= max) {
            setStreamEnded(true);
          }
          return changed;
        }

        if (!playbackAllowed(next.status)) {
          if (audioUrlRef.current) setAudioUrl(null);
          return changed;
        }

        if (!audioUrlRef.current && !liveSessionAttached(audioRef.current)) {
          const seeded = playbackForResume(next, playbackResume.savedRef.current, {
            forceStream,
            forceSegments,
          });
          armPlayback(seeded, next.status);
        }
      } catch {
        // Ignore polling errors
      }
      return changed;
    };

    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, jobStatus, jobKind, job?.audio_url, forceStream, forceSegments]);

  useEffect(() => {
    if (forceStream || forceSegments || jobStatus !== "ready" ||
        jobKind === "stream" || !job?.audio_url || !audioUrl) return;
    if (liveSessionAttached(audioRef.current)) return;
    const fullUrl = versionedAudioUrl(job.audio_url, job.updated_at);
    if (!fullUrl) return;
    const playingNow = audioRef.current;
    const snapshot = readySnapshotHandoff({
      status: jobStatus,
      src: audioUrl,
      fullUrl,
      currentTime: playingNow?.currentTime ?? 0,
      playing: Boolean(playingNow && (!playingNow.paused || playingNow.ended)),
    });
    if (snapshot.action === "handoff") {
      armPendingSeekRef.current({
        seconds: snapshot.at,
        fraction: 0,
        bookSeconds: snapshot.at,
      });
      playAfterLoadRef.current = snapshot.play;
      waitingForNextRef.current = false;
      setCurrentTime(snapshot.at);
      setAudioUrl(snapshot.url);
      return;
    }
    if (!audioUrl.includes("/sections/")) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const handoff = async () => {
      try {
        const doc = await transcriptResource.load(revision);
        if (stopped) return;
        const audio = audioRef.current;
        const seconds = sectionHandoffSeconds(doc, segmentIndexRef.current,
          audio?.currentTime ?? 0, audio?.duration ?? 0);
        if (seconds == null) {
          transcriptResource.invalidate(revision);
          throw new Error("Section timing unavailable");
        }
        armPendingSeekRef.current({ seconds, fraction: 0, bookSeconds: seconds });
        playAfterLoadRef.current = Boolean(audio && (!audio.paused || waitingForNextRef.current));
        waitingForNextRef.current = false;
        setAudioUrl(fullUrl);
      } catch {
        if (stopped) return;
        if (++attempts < 3) timer = setTimeout(handoff, attempts * 2000);
        else {
          const fallbackFrac = (job.total_sections ?? 0) > 0 ? segmentIndexRef.current / job.total_sections : 0;
          armPendingSeekRef.current({
            seconds: null,
            fraction: fallbackFrac,
            bookSeconds: null,
          });
          playAfterLoadRef.current = Boolean(audioRef.current && (!audioRef.current.paused || waitingForNextRef.current));
          waitingForNextRef.current = false;
          setAudioUrl(fullUrl);
        }
      }
    };
    void handoff();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [forceStream, forceSegments, jobStatus, jobKind, job?.audio_url, audioUrl, revision, transcriptResource]);

  // A ready book's download_url is minted once per fetch. Polling stops when
  // the book is ready, so a tab left open would hand out a dead signature.
  // Refresh on return and every half hour; the click itself cannot wait.
  useEffect(() => {
    if (jobStatus !== "ready") return;
    let stopped = false;
    const pull = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        const response = await fetch(`/api/jobs/${id}`);
        if (!response.ok) return;
        const data = await response.json();
        const url = data.job?.download_url as string | undefined;
        if (!url) return;
        setJob((prev) =>
          prev && prev.download_url !== url ? { ...prev, download_url: url } : prev
        );
      } catch {
        /* the next tap can try again */
      }
    };
    const timer = setInterval(() => void pull(), DOWNLOAD_URL_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void pull();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id, jobStatus]);

  useEffect(() => {
    if (!playbackAllowed(job?.status)) return;
    if (!waitingForNextRef.current || !job?.segments) return;
    const step = advanceAfterSection({
      segments: job.segments,
      from: segmentIndex,
      status: job.status,
    });
    if (step.action !== "play") return;
    waitingForNextRef.current = false;
    setSegmentIndex(step.index);
    playAfterLoadRef.current = true;
    setAudioUrl(withPlaybackGrant(`/api/storage/${step.path}`, job.playback_grant));
  }, [job, segmentIndex]);

  const handleSpawnTakehome = async () => {
    setSpawningTakehome(true);
    try {
      const res = await fetch(`/api/jobs/${id}/takehome`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setNotice(null);
      invalidateScreen(SCREEN_JOBS);
      // Stay with the new take-home job so progress is visible immediately.
      router.push(`/dashboard/player/${data.jobId}`);
    } catch (e: unknown) {
      setNotice(userFriendlyError(e instanceof Error ? e.message : "Failed"));
    } finally {
      setSpawningTakehome(false);
    }
  };

  // Initialize audio processor when audio element is ready. The element
  // belongs to the root-layout shell and outlives this page.
  useEffect(() => {
    if (audioRef.current && audioUrl && !processorInitialized.current) {
      initialize(audioRef.current);
      processorInitialized.current = true;
    }
  }, [audioUrl, initialize, audioRef]);

  /**
   * Point the shell's one element at this book's source. Assigning the same
   * URL again is a no-op, so a re-render never restarts the audio. The
   * shell releases it only for an explicit close or a book that may not play.
   */
  useEffect(() => {
    if (!audioUrl) return;
    setSource(audioUrl, id);
  }, [audioUrl, id, setSource]);

  /**
   * A book that lost the right to play (failed or cancelled) gives up the
   * source. A pause is not a reason: the platform notification outlives one.
   */
  useEffect(() => {
    if (!job) return;
    if (playbackAllowed(job.status)) return;
    releaseForJob(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, id, releaseForJob]);

  // Leaving a book that is still playing keeps the source in the shell; the
  // mini player is what the listener sees. Leaving while paused also keeps
  // it, so a long lock-screen resume still has a source to re-acquire.

  useEffect(() => {
    storageReloadRef.current = 0;
    lastRequestedSeekRef.current = null;
    // A new source is a new start request: its own recovery and watchdog.
    resetAudioStart();
    if (seenAudioUrlRef.current === audioUrl) return;
    seenAudioUrlRef.current = audioUrl;
    // The element clock restarted. A timer armed on the previous file must
    // not expire this one while it is still HAVE_NOTHING. A resume that is
    // still waiting for metadata keeps its book time, so a pause at 0:00
    // of the part cannot replace the saved position.
    const pendingBook = pendingChapterSeekRef.current?.bookSeconds;
    confirmedPlayheadRef.current =
      typeof pendingBook === "number" && pendingBook > 0.05 ? pendingBook : null;
    const audio = audioRef.current;
    if (pendingChapterSeekRef.current && (!audio || audio.readyState < 1)) {
      if (pendingSeekTimerRef.current != null) {
        window.clearTimeout(pendingSeekTimerRef.current);
        pendingSeekTimerRef.current = null;
      }
    }
  }, [audioUrl, resetAudioStart, audioRef]);

  // Re-apply the remembered rate whenever the element or the choice
  // changes. The rate comes from the shared preference store, so it survives
  // a reload and is the same in the mini player. Pitch correction is asked
  // for explicitly: browsers default it on today, but the narration voice is
  // the product, and a rate that shifts pitch would change the narrator
  // rather than the tempo.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    assignPlaybackRate(audio, speed);
  }, [speed, audioUrl, audioRef]);

  // Audio event listeners
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const effectiveDuration = (raw: number): number => {
      const fallback = jobRef.current?.duration_seconds ?? null;
      // A demuxer that latched onto a short header reports a fraction of the
      // book. The measured length is right; a sections file is not.
      const truncated =
        fallback != null &&
        fallback > 0 &&
        Number.isFinite(raw) &&
        raw > 0 &&
        raw < fallback * 0.5 &&
        !audioUrlRef.current?.includes("/sections/");
      return seekableDuration(truncated ? fallback : raw, fallback);
    };
    const applyDuration = (raw: number) => {
      setDuration(effectiveDuration(raw));
    };
    const onTimeUpdate = () => {
      const back = restoreLiveEdge(edgeHoldRef.current, audio.currentTime);
      if (back != null) {
        // One correction. Assigning currentTime can fire this listener again,
        // and a seek the element will not take must not spin.
        edgeHoldRef.current = null;
        try {
          audio.currentTime = back;
        } catch {
          /* the playhead stays where the element left it */
        }
        if (!isDraggingRef.current) setCurrentTime(back);
        return;
      }
      if (audio.currentTime > 0.5) {
        restoreLandedRef.current = true;
        const sought = lastRequestedSeekRef.current;
        const seekPending = sought != null && Math.abs(audio.currentTime - sought) > 1.5;
        if (!droppedSeekHoldRef.current && !seekPending) {
          const onSection = Boolean(audioUrlRef.current?.includes("/sections/"));
          const next = bookTimeFromElement({
            mode: onSection ? "section" : "full",
            elementSeconds: audio.currentTime,
            sectionIndex: onSection ? segmentIndexRef.current : null,
            spans: spansRef.current,
          }).seconds;
          const prev = confirmedPlayheadRef.current;
          if (prev == null || next + 1.5 >= prev) confirmedPlayheadRef.current = next;
        }
      }
      if (!isDraggingRef.current) setCurrentTime(audio.currentTime);
      // The requested seek landed once playback has moved on from it.
      if (
        lastRequestedSeekRef.current != null &&
        Math.abs(audio.currentTime - lastRequestedSeekRef.current) > 1.5
      ) {
        lastRequestedSeekRef.current = null;
      }
      if (storageReloadRef.current > 0 && audio.currentTime > 1) {
        storageReloadRef.current = 0;
      }
    };
    const consumePending = () => {
      const pending = pendingChapterSeekRef.current;
      if (!pending) return;
      const live = liveSessionAttached(audio);
      const elementDuration =
        Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const total = live ? elementDuration : effectiveDuration(audio.duration);
      if (!(total > 0 || pending.seconds != null)) return;
      const raw = pending.charIndex != null && pending.document
        ? sectionSeekSeconds(pending.document, pending.charIndex, total) ?? 0
        : pending.seconds ?? pending.fraction * total;
      // A growing Media Source reports the buffered length as duration.
      // Clamping a later resume onto the first segment would drop it.
      if (live && raw > 0.05 && seekTargetIfCovered(raw, elementDuration) == null) return;
      const seconds =
        total > 0 ? Math.min(raw, Math.max(0, total - 0.05)) : raw;
      // Duration can be known at loadedmetadata while the seekable range
      // still ends at 0. Assigning currentTime then is ignored and the part
      // stays at 0:00. A missing range (tests, or a file that has not
      // reported one) keeps the old attempt. canplay retries a real range.
      const ranges = audio.seekable;
      if (raw > 0.05 && ranges && ranges.length > 0) {
        let covers = false;
        for (let i = 0; i < ranges.length; i += 1) {
          if (seconds >= ranges.start(i) - 0.05 && seconds <= ranges.end(i) + 0.05) {
            covers = true;
            break;
          }
        }
        if (!covers) return;
      }
      const at = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
      if (Math.abs(at - seconds) > 0.5) {
        try {
          audio.currentTime = seconds;
        } catch {
          return;
        }
        const landed = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        if (Math.abs(landed - seconds) > 0.5) return;
      }
      clearPendingSeekRef.current();
      lastRequestedSeekRef.current = seconds;
      setCurrentTime(seconds);
      const book =
        typeof pending.bookSeconds === "number" && Number.isFinite(pending.bookSeconds)
          ? pending.bookSeconds
          : seconds;
      confirmedPlayheadRef.current = book;
      if (seconds > 0.5 || book > 0.5) restoreLandedRef.current = true;
    };
    const onDurationChange = () => {
      applyDuration(audio.duration);
      consumePending();
      ensurePendingExpiryRef.current();
    };
    const clearNoticeIfHealthy = () => {
      if (!audio.error) setNotice(null);
    };
    const onLoadedMetadata = () => {
      clearNoticeIfHealthy();
      applyDuration(audio.duration);
      consumePending();
      ensurePendingExpiryRef.current();
    };
    const onCanPlay = () => {
      clearNoticeIfHealthy();
      consumePending();
      if (playAfterLoadRef.current) {
        playAfterLoadRef.current = false;
        // Same guarded start as the transport: this is the reload path, and a
        // second failure here must not leave the button dead either.
        startAudio(audio);
      }
    };
    const onEnded = () => {
      const isStream = forceStream || jobRef.current?.job_kind === "stream";
      if (isStream) {
        const j = jobRef.current;
        const used = j?.stream_chars_used ?? 0;
        const max = j?.stream_max_chars ?? 0;
        if (max > 0 && used >= max) {
          setStreamEnded(true);
        } else if (j?.status === "queued" || j?.status === "ready") {
          setHeldStreamChar(streamCharRef.current);
          const nextUrl = openStreamUrl(`/api/jobs/${id}/stream`);
          playAfterLoadRef.current = true;
          setAudioUrl(nextUrl);
        }
        return;
      }
      if (
        audioUrlRef.current?.includes("/sections/") &&
        jobRef.current?.segments?.length
      ) {
        const current = segmentIndexRef.current;
        const span = spansRef.current.find((item) => item.index === current);
        const local = sectionFileSeconds({
          elementSeconds: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
          elementDuration: Number.isFinite(audio.duration) ? audio.duration : 0,
          ended: true,
        });
        const bookEnd = (span?.startSeconds ?? 0) + local;
        const step = advanceAfterSection({
          segments: jobRef.current.segments,
          from: current,
          status: jobRef.current.status,
        });
        // A poll that is already in flight must not attach somewhere else.
        releaseLiveSession(audio, bookEnd);
        if (step.action === "play") {
          waitingForNextRef.current = false;
          pinSection(step.index, bookEnd);
          rememberBookRef.current(bookEnd, "track", step.index);
          armPendingSeekRef.current({
            seconds: 0,
            fraction: 0,
            bookSeconds: bookEnd,
            sectionIndex: step.index,
          });
          setSegmentIndex(step.index);
          setCurrentTime(0);
          playAfterLoadRef.current = true;
          setAudioUrl(withPlaybackGrant(`/api/storage/${step.path}`, jobRef.current.playback_grant));
        } else if (step.action === "wait") {
          waitingForNextRef.current = true;
          rememberBookRef.current(bookEnd, "track", current);
          setCurrentTime(local);
        } else {
          rememberBookRef.current(bookEnd, "track", current);
        }
      } else {
        captureRef.current("track");
        const endedAt =
          Number.isFinite(audio.currentTime) && audio.currentTime > 0
            ? audio.currentTime
            : audio.duration;
        const step = continuePastPublishedPrefix({
          src: audioUrlRef.current,
          endedAt,
          spans: spansRef.current,
          segments: jobRef.current?.segments,
          status: jobRef.current?.status,
        });
        if (step.action === "play") {
          waitingForNextRef.current = false;
          const span = spansRef.current.find((item) => item.index === step.index);
          armPendingSeekRef.current({
            seconds: step.localSeconds,
            fraction: 0,
            bookSeconds: span ? span.startSeconds + step.localSeconds : null,
            sectionIndex: step.index,
          });
          setSegmentIndex(step.index);
          playAfterLoadRef.current = true;
          setAudioUrl(withPlaybackGrant(`/api/storage/${step.path}`, jobRef.current?.playback_grant));
        } else if (step.action === "wait") {
          waitingForNextRef.current = true;
          setSegmentIndex(step.index);
        }
      }
    };
    const onPlay = () => {
      heardPlayingRef.current = true;
      markMovedRef.current();
    };
    /**
     * The start request settled: audio is genuinely flowing. `play` fires as
     * soon as `paused` flips — before a byte is decoded — so it cannot be the
     * signal that cancels the start watchdog.
     */
    const onPlaying = () => {
      settleAudioStart();
      setNotice(null);
    };
    const onPause = () => {
      if (!audio.error) heardPlayingRef.current = false;
      // `ended` also pauses. That handler owns the position at a boundary.
      if (!audio.ended) captureRef.current("pause");
    };
    const onError = () => {
      const code = audio.error?.code ?? null;
      const src = audioUrlRef.current;
      if (
        src &&
        shouldReloadStorageAfterError({
          src,
          errorCode: code,
          alreadyReloaded: playbackRecoveryCount(src) >= 1,
        })
      ) {
        storageReloadRef.current += 1;
        // A reload during a seek must land on the requested spot, not on the
        // pre-seek playhead the element still reports.
        const at =
          lastRequestedSeekRef.current ??
          (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
        const onSection = Boolean(src.includes("/sections/"));
        const sectionIndex = onSection ? segmentIndexRef.current : null;
        const mapped = bookTimeFromElement({
          mode: onSection ? "section" : "full",
          elementSeconds: at,
          sectionIndex,
          spans: spansRef.current,
        });
        armPendingSeekRef.current({
          seconds: at,
          fraction: 0,
          bookSeconds: mapped.absolute ? mapped.seconds : null,
          sectionIndex,
        });
        playAfterLoadRef.current =
          heardPlayingRef.current || at > 0.05;
        // A new query misses a cached 206 or 302. load() on the same URL
        // would play that entry again.
        setNotice(null);
        setAudioUrl(cacheBustPlaybackUrl(src));
        return;
      }
      clearPendingSeekRef.current();
      const isStream = forceStream || jobRef.current?.job_kind === "stream";
      if (isStream) {
        setStreamEnded(true);
      } else {
        setNotice("Couldn't play this part. Try another.");
      }
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    const onSeeked = () => {
      clearNoticeIfHealthy();
      consumePending();
    };

    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("seeked", onSeeked);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);
    if (audio.readyState >= 1) onLoadedMetadata();

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("seeked", onSeeked);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
    };
  }, [audioUrl, forceStream, id, segmentIndex, openStreamUrl, settleAudioStart, startAudio, audioRef]);

  /**
   * One tap, one decision, taken from the shared element at tap time.
   *
   * `isPlaying` is a render-time reading; reading the element again here means
   * a pause that landed between the last render and the tap can never send a
   * `play()` to an element that is already playing (which resolves without
   * doing anything, so the button would look dead), and a resume can never be
   * swallowed by a stale "playing" reading.
   */
  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;

    if (elementIsPlaying(audio)) {
      listenerPausedRef.current = true;
      setLivePlayIntent(audio, false);
      stopAudio();
      return;
    }
    listenerPausedRef.current = false;
    const edge = liveSessionAttached(audio)
      ? liveEdgeSeconds(audio.currentTime, liveBufferedSeconds(audio))
      : null;
    edgeHoldRef.current = edge;
    if (edge != null && (audio.ended || audio.currentTime + 0.5 < edge)) {
      try {
        audio.currentTime = edge;
      } catch {
        /* timeupdate puts a slipped playhead back */
      }
    }
    if (edge != null) retargetLiveResume(audio, edge, true);
    setLivePlayIntent(audio, true);
    startAudio(audio);
    if (edge != null) {
      window.setTimeout(() => {
        if (edgeHoldRef.current === edge) edgeHoldRef.current = null;
      }, 2000);
    }
  };

  const isStreamMode = forceStream || job?.job_kind === "stream";
  const readAlongMode: ReadAlongMode = isStreamMode
    ? "stream"
    : audioUrl?.includes("/sections/")
      ? "section"
      : "full";

  const streamTimeline = job?.stream_timeline ?? null;
  const streamSynced = isStreamMode && timelineMatchesConn(streamTimeline, streamConn);
  const streamClock = useMemo(
    () => (transcript && streamSynced && streamTimeline
      ? streamClockDocument(transcript, streamTimeline) : null),
    [transcript, streamSynced, streamTimeline]
  );
  const streamChar = useMemo(
    () => streamClock
      ? charIndexForPlayback(streamClock, {
          mode: "full", currentTime, duration: 0, sectionIndex: null, streamCursor: null,
        })
      : null,
    [streamClock, currentTime]
  );
  useEffect(() => { streamCharRef.current = streamChar; }, [streamChar]);
  // A reconnect restarts the audio clock. Until the new connection's plan
  // arrives, keep the passage the listener was on.
  const streamHold =
    isStreamMode && heldStreamChar != null && currentTime < STREAM_HOLD_SECONDS
      ? heldStreamChar : null;
  // The playhead is close to, or past, the audio whose length is known.
  const streamNeedsLengths = Boolean(
    streamSynced && streamTimeline && job?.status === "processing" &&
    currentTime > streamCoveredSeconds(streamTimeline) - STREAM_LENGTH_LEAD_SECONDS
  );
  const streamWantsFastPoll =
    isStreamMode && showTranscript && (!streamSynced || streamNeedsLengths);
  useEffect(() => {
    streamFastPollRef.current = streamWantsFastPoll;
    streamIdlePollsRef.current = 0;
  }, [streamWantsFastPoll]);

  // One object per playhead change, shared by the inline panel and focus
  // mode, so the transcript's memoized rows see stable fields and skip the
  // 4 Hz re-render.
  const readAlongPosition = useMemo<ReadAlongPosition>(
    () => ({
      // A synced stream reads like a finished book: the measured window
      // clock maps the element's media time to text.
      mode: streamClock ? "full" : readAlongMode,
      currentTime,
      duration,
      sectionIndex: readAlongMode === "section" ? segmentIndex : null,
      streamCursor: streamClock ? null : streamHold,
    }),
    [streamClock, readAlongMode, currentTime, duration, segmentIndex, streamHold]
  );

  const onSectionFile = Boolean(audioUrl?.includes("/sections/"));
  const bookClock =
    onSectionFile && sectionOnBookClock(spans, segmentIndex) && !isStreamMode;
  const chaining =
    pendingChapterSeekRef.current?.seconds === 0 &&
    pendingChapterSeekRef.current.sectionIndex != null;
  const sectionLocal = onSectionFile
    ? sectionFileSeconds({
        elementSeconds: currentTime,
        elementDuration: duration,
        ended: Boolean(audioRef.current?.ended) && !chaining,
      })
    : currentTime;
  const bookNow = bookClock
    ? bookTimeFromElement({
        mode: "section",
        elementSeconds: sectionLocal,
        sectionIndex: segmentIndex,
        spans,
      }).seconds
    : currentTime;
  const fileDuration = duration > 0 ? duration : (job?.duration_seconds ?? 0);
  const bookDuration = bookClock
    ? Math.max(availableBookSeconds(spans, null, false), bookNow)
    : fileDuration;
  const shownTime = scrubBookTime ?? bookNow;

  const seekAbsolute = (bookSeconds: number) => {
    if (isStreamMode || !Number.isFinite(bookSeconds)) return;
    const liveAudio = audioRef.current;
    if (liveAudio && liveSessionAttached(liveAudio)) {
      const covered = liveBufferedSeconds(liveAudio);
      const wasPlaying = elementIsPlaying(liveAudio);
      const place = placeOnTimeline({ bookSeconds, spans });
      const seg = place ? readyByIndex(job?.segments).get(place.sectionIndex) : undefined;
      const sectionUrl = seg
        ? playbackUrlForStatus(job?.status, `/api/storage/${seg.path}`)
        : null;
      const choice = chooseLivePart({
        attached: true,
        target: bookSeconds,
        covered,
        sectionUrl: sectionUrl ?? "",
        playing: wasPlaying,
      });
      if (choice.action === "seek") {
        rememberBookRef.current(bookSeconds, "seek", null);
        liveAudio.currentTime = choice.at;
        retargetLiveResume(liveAudio, choice.at, true);
        setCurrentTime(choice.at);
        confirmedPlayheadRef.current = choice.at;
        if (choice.play) void liveAudio.play().catch(() => {});
        return;
      }
      if (sectionUrl && seg && place) {
        const span = spans.find((item) => item.index === place.sectionIndex);
        if (span) pinSection(span.index, span.startSeconds);
        rememberBookRef.current(place.bookSeconds, "seek", place.sectionIndex);
        releaseLiveSession(liveAudio, bookSeconds);
        listenerPausedRef.current = !choice.play;
        armPendingSeekRef.current({
          seconds: place.localSeconds,
          fraction: 0,
          bookSeconds: place.bookSeconds,
          sectionIndex: place.sectionIndex,
        });
        playAfterLoadRef.current = choice.play;
        setSegmentIndex(place.sectionIndex);
        setCurrentTime(place.localSeconds);
        setAudioUrl(sectionUrl);
        return;
      }
    }
    if (!bookClock) return;
    const place = placeOnTimeline({ bookSeconds, spans });
    if (!place) return;
    const seg = readyByIndex(job?.segments).get(place.sectionIndex);
    if (!seg) return;
    const nextUrl = playbackUrlForStatus(job?.status, `/api/storage/${seg.path}`);
    if (!nextUrl) return;
    // Read before the seek. The handler installed on the shell closes over
    // an older render, and a seek can pause the element; the flag from that
    // render would start a book the listener had just paused.
    const wasPlaying = elementIsPlaying(audioRef.current);
    const span = spans.find((item) => item.index === place.sectionIndex);
    if (span) pinSection(span.index, span.startSeconds);
    rememberBookRef.current(place.bookSeconds, "seek", place.sectionIndex);
    const same =
      audioUrl != null &&
      samePlaybackSource(audioUrl, nextUrl) &&
      segmentIndex === place.sectionIndex;
    const audio = audioRef.current;
    if (!same || !audio || audio.readyState < 1) {
      armPendingSeekRef.current({
        seconds: place.localSeconds,
        fraction: 0,
        bookSeconds: place.bookSeconds,
        sectionIndex: place.sectionIndex,
      });
      playAfterLoadRef.current = wasPlaying;
      setSegmentIndex(place.sectionIndex);
      setCurrentTime(place.localSeconds);
      if (!same) setAudioUrl(nextUrl);
      return;
    }
    clearPendingSeekRef.current();
    lastRequestedSeekRef.current = place.localSeconds;
    audio.currentTime = place.localSeconds;
    setCurrentTime(place.localSeconds);
    if (wasPlaying) audio.play().catch(() => {});
  };

  const handleScrub = (seconds: number) => {
    if (isStreamMode) return;
    if (bookClock) setScrubBookTime(seconds);
    else setCurrentTime(seconds);
  };

  const handleScrubCommit = (seconds: number) => {
    if (isStreamMode || !Number.isFinite(seconds)) return;
    setScrubBookTime(null);
    if (bookClock || (audioRef.current && liveSessionAttached(audioRef.current))) {
      seekAbsolute(seconds);
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    const wasPlaying = elementIsPlaying(audio);
    rememberBookRef.current(seconds, "seek", onSectionFile ? segmentIndex : null);
    // Before metadata the element has no seekable range. Hold the seek and
    // let loadedmetadata apply it against the real file.
    if (audio.readyState < 1) {
      const mapped = bookTimeFromElement({
        mode: onSectionFile ? "section" : "full",
        elementSeconds: seconds,
        sectionIndex: onSectionFile ? segmentIndex : null,
        spans,
      });
      armPendingSeekRef.current({
        seconds,
        fraction: 0,
        bookSeconds: mapped.absolute ? mapped.seconds : null,
        sectionIndex: onSectionFile ? segmentIndex : null,
      });
      playAfterLoadRef.current = wasPlaying;
      setCurrentTime(seconds);
      return;
    }
    if (
      job?.status !== "ready" &&
      audioUrl &&
      !audioUrl.includes("/sections/") &&
      Number.isFinite(audio.duration) &&
      audio.duration > 0 &&
      seconds > audio.duration
    ) {
      armPendingSeekRef.current({
        seconds,
        fraction: 0,
        bookSeconds: seconds,
        sectionIndex: null,
      });
      if (liveSessionAttached(audio)) retargetLiveResume(audio, seconds, false);
      return;
    }
    clearPendingSeekRef.current();
    lastRequestedSeekRef.current = seconds;
    audio.currentTime = seconds;
    if (liveSessionAttached(audio)) retargetLiveResume(audio, seconds, true);
    if (wasPlaying) {
      audio.play().catch(() => {});
    }
  };

  const seekToChar = (charIndex: number) => {
    if (isStreamMode || !transcript) return;
    const seek = passageSeekForChar(transcript, charIndex);
    const audio = audioRef.current;
    const knownDuration =
      audio && Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : duration;
    // The element can report a duration shorter than the book when the file
    // head lied about its length. Fractions need the real total.
    const totalDur =
      job?.duration_seconds && job.duration_seconds > 0
        ? Math.max(knownDuration, job.duration_seconds)
        : knownDuration;
    const onSection = Boolean(audioUrl?.includes("/sections/"));
    const sectionFraction = seek.sectionFraction ?? 0;
    if (onSection && seek.sectionIndex != null && seek.sectionIndex !== segmentIndex) {
      const seg = readyByIndex(job?.segments).get(seek.sectionIndex);
      if (!seg) return;
      const span = spans.find((item) => item.index === seek.sectionIndex);
      if (span) {
        rememberBookRef.current(span.startSeconds + sectionFraction * span.durationSeconds, "seek", null);
      }
      armPendingSeekRef.current({
        seconds: null,
        fraction: sectionFraction,
        charIndex,
        document: transcript,
        bookSeconds: span
          ? span.startSeconds + sectionFraction * span.durationSeconds
          : null,
        sectionIndex: seek.sectionIndex,
      });
      playAfterLoadRef.current = true;
      setSegmentIndex(seek.sectionIndex);
      setCurrentTime(0);
      releaseLiveSession(
        audio,
        span ? span.startSeconds + sectionFraction * span.durationSeconds : undefined
      );
      setAudioUrl(`/api/storage/${seg.path}`);
      return;
    }
    const seconds = onSection
      ? (() => {
          // A per-section file plays on its own clock, so the target has to
          // be scaled to that file's length — not the whole book's.
          const localDuration =
            audio && Number.isFinite(audio.duration) && audio.duration > 0
              ? audio.duration
              : (transcript.sections.find((s) => s.index === segmentIndex)?.durationSeconds ?? 0);
          return localDuration > 0
            ? sectionSeekSeconds(transcript, charIndex, localDuration)
            : null;
        })()
      : (seek.fullSeconds ?? (totalDur > 0 ? seek.fraction * totalDur : null));
    if (seconds == null && audio && audio.readyState >= 1) {
      clearPendingSeekRef.current();
      return;
    }
    if (!audio || audio.readyState < 1 || seconds == null) {
      armPendingSeekRef.current(onSection
        ? { seconds, fraction: sectionFraction, charIndex, document: transcript }
        : { seconds, fraction: seek.fraction });
      playAfterLoadRef.current = true;
      if (seconds != null) {
        setCurrentTime(seconds);
        const placed = bookTimeFromElement({
          mode: onSection ? "section" : "full",
          elementSeconds: seconds,
          sectionIndex: onSection ? segmentIndex : null,
          spans,
        });
        rememberBookRef.current(
          placed.seconds,
          "seek",
          placed.absolute ? null : onSection ? segmentIndex : null
        );
        if (liveSessionAttached(audio)) retargetLiveResume(audio, placed.seconds, false);
      }
      if (audio) audio.play().catch(() => { audio.load(); });
      return;
    }
    clearPendingSeekRef.current();
    lastRequestedSeekRef.current = seconds;
    audio.currentTime = seconds;
    if (liveSessionAttached(audio)) {
      const held = bookTimeFromElement({
        mode: onSection ? "section" : "full",
        elementSeconds: seconds,
        sectionIndex: onSection ? segmentIndex : null,
        spans,
      });
      retargetLiveResume(audio, held.seconds, true);
    }
    setCurrentTime(seconds);
    const placed = bookTimeFromElement({
      mode: onSection ? "section" : "full",
      elementSeconds: seconds,
      sectionIndex: onSection ? segmentIndex : null,
      spans,
    });
    rememberBookRef.current(placed.seconds, "seek", placed.absolute ? null : onSection ? segmentIndex : null);
    if (audio.paused) audio.play().catch(() => {});
  };

  const openChapter = (chapter: { startFraction: number; startSeconds?: number }) => {
    if (isStreamMode) return;
    const fraction = Math.min(1, Math.max(0, chapter.startFraction));
    const full = job?.audio_url ?? null;
    const audio = audioRef.current;
    const knownDuration =
      audio && Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : duration;
    const totalDur =
      job?.duration_seconds && job.duration_seconds > 0
        ? Math.max(knownDuration, job.duration_seconds)
        : knownDuration;
    const targetSeconds =
      chapter.startSeconds != null
        ? chapter.startSeconds
        : totalDur > 0
          ? fraction * totalDur
          : null;
    const pending = {
      seconds: chapter.startSeconds ?? null,
      fraction,
      bookSeconds: targetSeconds,
    };
    if (targetSeconds != null) rememberBookRef.current(targetSeconds, "seek", null);
    const switchingFile = Boolean(full && audioUrl?.split("?")[0] !== full);
    if (targetSeconds == null && audio && audio.readyState >= 1 && !switchingFile) {
      clearPendingSeekRef.current();
      return;
    }
    if (
      audio &&
      liveSessionAttached(audio) &&
      targetSeconds != null &&
      full
    ) {
      const covered = liveBufferedSeconds(audio);
      const decision = liveChapterSeek({
        target: targetSeconds,
        covered,
        fullUrl: full,
        playing: elementIsPlaying(audio),
      });
      if (decision?.action === "handoff") {
        releaseLiveSession(audio, decision.at);
        listenerPausedRef.current = !decision.play;
        armPendingSeekRef.current(pending);
        playAfterLoadRef.current = decision.play;
        setCurrentTime(decision.at);
        const next = versionedAudioUrl(full, job?.updated_at);
        if (next) setAudioUrl(next);
        return;
      }
    }
    if (full && audioUrl?.split("?")[0] !== full && !liveSessionAttached(audio)) {
      armPendingSeekRef.current(pending);
      playAfterLoadRef.current = true;
      setAudioUrl(versionedAudioUrl(full, job?.updated_at));
      if (targetSeconds != null) setCurrentTime(targetSeconds);
      return;
    }
    if (!audio || audio.readyState < 1 || targetSeconds == null) {
      armPendingSeekRef.current(pending);
      playAfterLoadRef.current = true;
      if (targetSeconds != null) setCurrentTime(targetSeconds);
      if (audio) {
        if (liveSessionAttached(audio) && targetSeconds != null) {
          retargetLiveResume(audio, targetSeconds, false);
        }
        audio.play().catch(() => { audio.load(); });
      }
      return;
    }
    clearPendingSeekRef.current();
    lastRequestedSeekRef.current = targetSeconds;
    audio.currentTime = targetSeconds;
    if (liveSessionAttached(audio)) retargetLiveResume(audio, targetSeconds, true);
    setCurrentTime(targetSeconds);
    if (!audio.error) setNotice(null);
    if (audio.paused) {
      audio.play().catch(() => {});
    }
  };

  const handleSkip = (delta: number) => {
    if (isStreamMode || !audioRef.current) return;
    if (bookClock) {
      const elementSeconds = sectionFileSeconds({
        elementSeconds: audioRef.current.currentTime,
        elementDuration: Number.isFinite(audioRef.current.duration) ? audioRef.current.duration : 0,
        ended: audioRef.current.ended,
      });
      const at = bookTimeFromElement({
        mode: "section",
        elementSeconds,
        sectionIndex: segmentIndex,
        spans,
      }).seconds;
      seekAbsolute(clampSeekSeconds(at, delta, Math.max(bookDuration, at + Math.max(0, delta))));
      return;
    }
    const wasPlaying = elementIsPlaying(audioRef.current);
    const next = clampSeekSeconds(
      audioRef.current.currentTime,
      delta,
      seekableDuration(audioRef.current.duration, fileDuration)
    );
    audioRef.current.currentTime = next;
    if (liveSessionAttached(audioRef.current)) retargetLiveResume(audioRef.current, next, true);
    setCurrentTime(next);
    const placed = bookTimeFromElement({
      mode: onSectionFile ? "section" : "full",
      elementSeconds: next,
      sectionIndex: onSectionFile ? segmentIndex : null,
      spans,
    });
    rememberBookRef.current(placed.seconds, "seek", onSectionFile ? segmentIndex : null);
    if (wasPlaying) {
      audioRef.current.play().catch(() => {});
    }
  };

  const applySpeed = useCallback(
    (next: number) => {
      setSpeed(next);
      const audio = audioRef.current;
      if (!audio) return;
      assignPlaybackRate(audio, next);
    },
    [setSpeed, audioRef]
  );

  const handleDownload = () => {
    if (!job) return;
    const href = audiobookDownloadUrl(
      job.download_url,
      `/api/jobs/${job.id}/download`
    );
    if (!href) {
      setNotice("That download link expired. Try again.");
      void fetch(`/api/jobs/${id}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          const url = data?.job?.download_url as string | undefined;
          if (!url) return;
          setJob((prev) =>
            prev && prev.download_url !== url ? { ...prev, download_url: url } : prev
          );
        })
        .catch(() => {});
      return;
    }
    try {
      startAudiobookDownload(href, audiobookFilename(job.book_title));
      setNotice(isIosDownload() ? UX.downloadOpened : null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Download failed. Try again.");
    }
  };

  const openTranscript = () => setShowTranscript((shown) => !shown);

  /** Focus mode always has transcript text behind it, and leaving it reveals the panel. */
  const setFocus = useCallback(
    (next: boolean) => {
      setFocusTranscript(next);
      setShowTranscript(true);
    },
    [setFocusTranscript]
  );

  useEffect(() => {
    // Focus mode needs the same document, even when the inline panel is shut.
    if (!(showTranscript || focusTranscript) || !revision) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const pull = async () => {
      setTranscriptLoading(true);
      setTranscriptError(false);
      try {
        const data = await transcriptResource.load(revision);
        if (!stopped) setTranscript(data);
      } catch {
        if (!stopped) {
          setTranscriptError(true);
          if (++attempts < 3) timer = setTimeout(pull, attempts * 2000);
        }
      } finally {
        if (!stopped) setTranscriptLoading(false);
      }
    };
    void pull();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [showTranscript, focusTranscript, revision, transcriptResource, transcriptRetry]);

  const liveAttached = !isStreamMode && liveSessionAttached(audioRef.current);
  const onRollingFile =
    !isStreamMode &&
    Boolean(audioUrl) &&
    !audioUrl!.includes("/sections/") &&
    job?.status !== "ready";
  const playDuration = onRollingFile || liveAttached
    ? growingFileDuration(duration, job?.duration_seconds)
    : duration > 0
      ? duration
      : (job?.duration_seconds ?? 0);
  useEffect(() => {
    if (forceSegments || isStreamMode || !job || job.job_kind === "stream") return;
    const audio = audioRef.current;
    if (!audio) return;
    const attached = liveSessionAttached(audio);
    if (job.status === "ready" && !attached) return;
    if (
      job.status !== "processing" &&
      job.status !== "queued" &&
      job.status !== "waiting" &&
      !attached
    ) {
      return;
    }
    // The worker writes live.m3u8 only once a stable prefix of full.mp3 is
    // uploaded. Asking before that is a 404, and the section file is the
    // source until then.
    const livePublished =
      Boolean(job.audio_url) ||
      (typeof job.duration_seconds === "number" && job.duration_seconds > 0);
    if (!attached && !livePublished) return;
    let stopped = false;
    const onSection = Boolean(
      (audio.getAttribute("src") || audioUrlRef.current || "").includes("/sections/")
    );
    const elementSeconds = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const saved = playbackResume.savedRef.current;
    const bookAt = liveAttachResumeAt({
      elementSeconds,
      onSection,
      sectionStart: onSection ? elementClockOffset(spansRef.current, segmentIndexRef.current) : 0,
      saved,
      savedSectionStart:
        saved?.sectionIndex != null ? elementClockOffset(spansRef.current, saved.sectionIndex) : 0,
    });
    const playing =
      elementIsPlaying(audio) ||
      (audio.ended && !listenerPausedRef.current && onSection);
    const token = liveAttachToken(audio);
    void syncLivePlayback({
      audio,
      playlistUrl: `/api/storage/audiobooks/${job.id}/live.m3u8`,
      jobId: job.id,
      resumeAt: bookAt,
      play: playing && !listenerPausedRef.current,
      listenerPaused: listenerPausedRef.current,
    }).then((result) => {
      if (stopped || liveAttachToken(audio) !== token || !liveSessionAttached(audio)) return;
      if (!result.attached || !result.url) return;
      const decision = liveReadyTransition({
        transport: result.transport,
        complete: result.complete,
        ready: job.status === "ready",
        fullUrl: job.audio_url ?? null,
        currentSrc: audio.getAttribute("src"),
        currentTime: bookAt,
        confirmedAt: confirmedPlayheadRef.current,
        playing,
        listenerPaused: listenerPausedRef.current,
      });
      if (decision.action === "handoff") {
        releaseLiveSession(audio);
        listenerPausedRef.current = !decision.play;
        armPendingSeekRef.current({
          seconds: decision.at,
          fraction: 0,
          bookSeconds: decision.at,
        });
        playAfterLoadRef.current = decision.play;
        setCurrentTime(decision.at);
        const next = versionedAudioUrl(decision.url, job.updated_at);
        if (next) setAudioUrl(next);
        return;
      }
      if (audioUrlRef.current !== result.url) setAudioUrl(result.url);
    }).catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [forceSegments, isStreamMode, job, audioRef, playbackResume]);
  const chapterSource =
    job && job.status === "ready" && !isStreamMode ? (job.chapters ?? null) : null;
  const preparedChapters = useMemo(
    () => prepareChapterView(chapterSource, playDuration),
    [chapterSource, playDuration]
  );
  const view = preparedChapters(currentTime);
  const [chaptersOpen, toggleChapters] = useChapterListOpen(id);
  const chapterNav = view.enabled;
  const chapterKeys = useRef({
    enabled: false,
    previous: () => {},
    next: () => {},
  });
  const skipTo = (target: { startFraction: number; startSeconds?: number } | null) => {
    if (target) openChapter(target);
  };
  chapterKeys.current = {
    enabled: chapterNav,
    previous: () => skipTo(view.previous),
    next: () => skipTo(view.next),
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key !== "[" && event.key !== "]") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }
      if (!window.matchMedia("(min-width: 768px)").matches) return;
      if (!chapterKeys.current.enabled) return;
      event.preventDefault();
      if (event.key === "[") chapterKeys.current.previous();
      else chapterKeys.current.next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sessionMeta = mediaSessionFields({
    bookTitle: job?.book_title ?? "",
    chapterLabel: chapterNav ? view.dragLabel : null,
    voiceName: job?.voice_name,
  });
  /**
   * Hand the shell what the platform needs: metadata, the book clock, and
   * the page's own transport. The shell keeps the metadata, handlers, and
   * the one media element after this page unmounts, which is what keeps the
   * Android notification alive while the listener is in another app.
   */
  const sessionActive = mediaSessionActive(job?.status, Boolean(audioUrl));
  const sessionPosition = bookClock ? shownTime : currentTime;
  const sessionDuration = bookClock ? bookDuration : playDuration;
  /**
   * The parts with their playback URLs, so the shell can change parts after
   * this page unmounts (a mini-player seek across a boundary, or the end of a
   * part with no page to run the handoff).
   */
  const sessionParts = useMemo(() => {
    const ready = readyByIndex(job?.segments);
    return spans.map((span) => {
      const segment = ready.get(span.index);
      return segment ? { ...span, url: `/api/storage/${segment.path}` } : span;
    });
  }, [spans, job?.segments]);
  useEffect(() => {
    reportSession({
      active: sessionActive,
      jobId: sessionActive ? id : null,
      title: sessionMeta.title,
      artist: sessionMeta.artist ?? null,
      album: sessionMeta.album ?? null,
      duration: sessionDuration,
      position: sessionPosition,
      elementOffset: bookClock ? elementClockOffset(spans, segmentIndex) : 0,
      parts: sessionParts,
      seekable: sessionActive && !isStreamMode,
      play: () => {
        // `ended` leaves `paused` false on some engines. A paused-only check
        // then ignores the lock-screen Play, which is the dead button again.
        const audio = audioRef.current;
        if (!audio || elementIsPlaying(audio)) return;
        void togglePlayback();
      },
      pause: () => {
        // stop clears the start watchdog. A raw pause leaves that timer armed,
        // and it reloads the file after the listener has already stopped.
        listenerPausedRef.current = true;
        stopAudio();
      },
      seek: bookClock ? seekAbsolute : handleScrubCommit,
      skip: handleSkip,
      chapter: chapterNav ? (direction) => skipTo(direction === "previous" ? view.previous : view.next) : null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    reportSession,
    detachSession,
    id,
    sessionActive,
    sessionMeta.title,
    sessionMeta.artist,
    sessionMeta.album,
    sessionDuration,
    sessionPosition,
    isStreamMode,
    bookClock,
    currentTime,
    segmentIndex,
    spans,
    sessionParts,
    chapterNav,
    view.previous,
    view.next,
  ]);

  // Leaving this page stops the shell calling back into a page that is gone.
  // It does not stop the audio: the element, the metadata, and the handlers
  // stay in the root-layout shell, which is what keeps the Android
  // notification alive while the listener is in another app.
  useEffect(() => detachSession, [detachSession]);

  const smoothedEtaLabel = useSmoothedEtaLabel(
    job ?? { id: "", eta_seconds: null, eta_label: null, eta_state: null }
  );

  const shownBookmarks = useMemo(
    () => sortBookmarksByClock(jobBookmarks.bookmarks, spans),
    [jobBookmarks.bookmarks, spans]
  );

  const saveBookmark = () => {
    if (!audioUrl || isStreamMode) return;
    const audio = audioRef.current;
    const element =
      audio && Number.isFinite(audio.currentTime) ? audio.currentTime : currentTime;
    const mapped = bookTimeFromElement({
      mode: onSectionFile ? "section" : "full",
      elementSeconds: element,
      sectionIndex: onSectionFile ? segmentIndex : null,
      spans,
    });
    const positionSeconds = mapped.absolute ? mapped.seconds : Math.max(0, element);
    const sectionIndex = mapped.absolute ? null : onSectionFile ? segmentIndex : null;
    void jobBookmarks.save(
      { positionSeconds, sectionIndex, label: null },
      jobBookmarks.bookmarks.map((row) => bookmarkOnAbsoluteClock(row, spans))
    );
  };

  const jumpToBookmark = (bookmark: JobBookmark) => {
    if (isStreamMode) return;
    const absolute = absoluteBookmarkSeconds(bookmark, spans);
    if (absolute != null && bookClock) {
      seekAbsolute(absolute);
      return;
    }
    const seconds = Math.max(0, absolute ?? bookmark.positionSeconds);
    if (absolute == null && bookmark.sectionIndex != null) {
      const seg = readyByIndex(job?.segments).get(bookmark.sectionIndex);
      if (!seg) return;
      const onSection =
        Boolean(audioUrl?.includes("/sections/")) && segmentIndex === bookmark.sectionIndex;
      const audio = audioRef.current;
      rememberBookRef.current(seconds, "seek", bookmark.sectionIndex);
      if (onSection && audio && audio.readyState >= 1) {
        clearPendingSeekRef.current();
        lastRequestedSeekRef.current = seconds;
        audio.currentTime = seconds;
        setCurrentTime(seconds);
        if (audio.paused) audio.play().catch(() => {});
        return;
      }
      armPendingSeekRef.current({
        seconds,
        fraction: 0,
        bookSeconds: null,
        sectionIndex: bookmark.sectionIndex,
      });
      playAfterLoadRef.current = true;
      setSegmentIndex(bookmark.sectionIndex);
      setCurrentTime(seconds);
      setAudioUrl(`/api/storage/${seg.path}`);
      return;
    }
    rememberBookRef.current(seconds, "seek", null);
    const full = job?.audio_url ? versionedAudioUrl(job.audio_url, job.updated_at) : null;
    if (!full) return;
    const onFull = audioUrl != null && !audioUrl.includes("/sections/");
    const audio = audioRef.current;
    if (!onFull || !audio || audio.readyState < 1) {
      armPendingSeekRef.current({ seconds, fraction: 0, bookSeconds: seconds });
      playAfterLoadRef.current = true;
      setCurrentTime(seconds);
      if (!onFull) setAudioUrl(full);
      return;
    }
    clearPendingSeekRef.current();
    lastRequestedSeekRef.current = seconds;
    audio.currentTime = seconds;
    setCurrentTime(seconds);
    if (!audio.error) setNotice(null);
    if (audio.paused) audio.play().catch(() => {});
  };

  const bookmarkControl = (
    <PlayerBookmarks
      bookmarks={shownBookmarks}
      disabled={isStreamMode || !audioUrl}
      pending={jobBookmarks.pending}
      notice={jobBookmarks.notice}
      noticeText={jobBookmarks.noticeText}
      placeLabel={(bookmark) => bookmarkClockLabel(bookmark, spans)}
      onSave={saveBookmark}
      onJump={jumpToBookmark}
      onRemove={(bookmarkId) => {
        void jobBookmarks.remove(bookmarkId);
      }}
    />
  );

  if (error) {
    return (
      <div className="max-w-2xl mx-auto pt-8 pb-20 text-center space-y-4">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Link
          href={LIBRARY_HREF}
          prefetch={PREFETCH_SCREEN}
          className="tap text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Library
        </Link>
      </div>
    );
  }

  if (!job) {
    return <PlayerLoadingShell />;
  }

  const narration = generationStatus({
    status: job.status,
    currentSection: job.current_section,
    totalSections: job.total_sections,
    segments: job.segments,
    etaLabel: job.waiting_for_text ? "Estimating…" : smoothedEtaLabel,
    etaState: job.waiting_for_text ? "estimating" : job.eta_state,
    waitingForText: job.waiting_for_text,
    provider: job.tts_provider,
  });
  const statusLine = playerStatusLine(job, narration.line);
  const showPlay = playerShowsPlay(job.status);

  return (
    <div className="mx-auto w-full max-w-3xl pt-8 pb-20 font-sans md:pt-6 md:pb-12">
      {/* Back button */}
      <Link
        href={LIBRARY_HREF}
        prefetch={PREFETCH_SCREEN}
        className="tap inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors mb-8 md:mb-4"
      >
        <ArrowLeft aria-hidden="true" className="w-3.5 h-3.5" />
        Library
      </Link>

      <div className="md:flex md:min-h-[min(32rem,calc(100dvh-14rem))] md:flex-col md:justify-center">
        <div className="mb-10 space-y-2 text-center md:mb-14">
        <div className="flex min-w-0 items-start justify-center gap-1 px-4">
          <EditableBookTitle
            jobId={job.id}
            title={job.book_title}
            onRenamed={(title) =>
              setJob((prev) => (prev ? { ...prev, book_title: title } : prev))
            }
            inputClassName={cn(
              "text-center font-serif tracking-tight",
              bookTitleHeadingClass(job.book_title)
            )}
          >
            <h1
              // A long title steps down rather than running off a phone
              // screen, and always wraps on a space instead of mid-word.
              className={cn(
                "min-w-0 max-w-full wrap-break-word font-serif tracking-tight text-balance text-foreground",
                bookTitleHeadingClass(job.book_title)
              )}
              style={{ fontWeight: 300 }}
              title={job.book_title}
            >
              {job.book_title}
            </h1>
          </EditableBookTitle>
        </div>
        {job.voice_name ? (
          <p className="text-sm text-muted-foreground font-serif">{job.voice_name}</p>
        ) : null}
        {chapterNav && view.line ? (
          <NowPlayingLine line={view.line} open={chaptersOpen} onToggle={toggleChapters} />
        ) : null}
        {statusLine ? (
          <p className="text-xs text-muted-foreground" role="status">
            {statusLine}
          </p>
        ) : null}
        {job.status === "failed" ? (
          <p className="text-xs text-muted-foreground" role="alert">
            {customerBookStatus(job.error_message, "failed") ?? UX.failed}
          </p>
        ) : job.status !== "cancelled" && customerBookStatus(job.warning, job.status) ? (
          <p className="text-xs text-muted-foreground" role="status">
            {customerBookStatus(job.warning, job.status)}
          </p>
        ) : null}
        {narration.showStop ? (
          <button
            type="button"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" })
                .then((response) => {
                  if (!response.ok) return;
                  const prev = jobRef.current?.id === job.id ? jobRef.current : job;
                  setJob(commitUserStop(jobRef, prev));
                })
                .finally(() => setStopping(false));
            }}
            className="tap text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : null}
        {notice ? (
          <p className="text-xs text-muted-foreground" role="status">
            {notice}
          </p>
        ) : null}
      </div>

      {(forceStream || job.job_kind === "stream") && (
        <div className="mb-8 text-center space-y-2">
          {streamEnded ? (
            <p className="text-xs text-muted-foreground">{UX.listeningPaused}</p>
          ) : null}
          <button
            type="button"
            disabled={spawningTakehome}
            onClick={handleSpawnTakehome}
            className="tap text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          >
            {spawningTakehome ? UX.fullBookStarted : UX.saveFullBook}
          </button>
        </div>
      )}

      <div className="flex flex-col items-center gap-8 md:gap-10 mb-8">
        {showPlay ? (
        <PlayerTransport
          audioReady={Boolean(audioUrl)}
          playing={isPlaying}
          skipDisabled={isStreamMode}
          showChapters={chapterNav}
          previousDisabled={!view.previous}
          nextDisabled={!view.next}
          onToggle={() => {
            void togglePlayback();
          }}
          onSkip={handleSkip}
          onPrevious={() => skipTo(view.previous)}
          onNext={() => skipTo(view.next)}
        />
        ) : null}

        {showPlay && audioUrl ? (
          <>
            <PlayerSeekGroup
              currentTime={bookClock ? shownTime : currentTime}
              duration={bookClock ? bookDuration : playDuration}
              disabled={isStreamMode}
              fineVisible={preciseSeek}
              onFineVisibleChange={setPreciseSeek}
              ticks={chapterNav ? view.ticks : undefined}
              chapterLabel={chapterNav ? view.dragLabel : null}
              onScrub={handleScrub}
              onScrubCommit={handleScrubCommit}
              onScrubActiveChange={(active) => {
                setIsDragging(active);
                if (!active) setScrubBookTime(null);
              }}
            />
            <div className="flex items-center justify-center gap-1">
              {focusTranscript && transcript ? null : bookmarkControl}
              <PlayerSpeedControl
                speed={speed}
                onSpeedChange={applySpeed}
              />
            </div>
          </>
        ) : null}
        <button
          type="button"
          aria-expanded={showTranscript}
          onClick={() => {
            void openTranscript();
          }}
          className="tap text-xs text-muted-foreground/70 hover:text-foreground transition-colors"
        >
          {showTranscript ? "Hide transcript" : "Transcript"}
        </button>
        </div>
      </div>

      {/* The focus overlay carries its own copy, so the page panel steps aside. */}
      {showTranscript && !focusTranscript ? (
        <div className="mt-4 mb-8">
          {transcriptError ? (
            <p role="status" className="text-center text-sm text-muted-foreground">
              Couldn&apos;t refresh the transcript. <button type="button" onClick={() => setTranscriptRetry((n) => n + 1)}>Retry transcript</button>
            </p>
          ) : null}
          {!transcript && transcriptLoading ? (
            <p className="text-center text-sm text-muted-foreground">Opening…</p>
          ) : transcript ? (
            <ReadAlongTranscript
              document={streamClock ?? transcript}
              onSeek={!showPlay || isStreamMode ? undefined : seekToChar}
              onToggleFullscreen={() => setFocus(true)}
              position={readAlongPosition}
            />
          ) : null}
        </div>
      ) : null}

      {focusTranscript && transcript ? (
        <ReadAlongFocus
          document={streamClock ?? transcript}
          position={readAlongPosition}
          onSeek={!showPlay || isStreamMode ? undefined : seekToChar}
          playback={showPlay}
          bookTitle={job.book_title}
          statusLine={statusLine}
          chapterTitle={chapterNav ? view.dragLabel : null}
          playing={isPlaying}
          speed={speed}
          currentTime={bookClock ? shownTime : currentTime}
          duration={bookClock ? bookDuration : playDuration}
          streamMode={isStreamMode}
          onToggle={() => {
            void togglePlayback();
          }}
          onClose={() => setFocus(false)}
          onSkip={handleSkip}
          onScrub={handleScrub}
          onScrubCommit={handleScrubCommit}
          onScrubActiveChange={(active) => {
            setIsDragging(active);
            if (!active) setScrubBookTime(null);
          }}
          onSpeedChange={applySpeed}
          bookmarkControl={bookmarkControl}
        />
      ) : null}

      <PlayerChapterSheet
        open={chaptersOpen && chapterNav}
        rows={view.rows}
        activeId={view.activeId}
        activePartId={view.activePartId}
        onClose={toggleChapters}
        onSeek={openChapter}
      />

      {/* Segment playlist while the book is still generating, or when it has no chapters */}
      {!chapterNav &&
        (job.status !== "ready" || forceSegments) &&
        job.segments?.some((s) => s.status === "ready") &&
        !forceStream &&
        job.job_kind !== "stream" && (
        <div className="mt-6">
          <button
            type="button"
            aria-expanded={showSections}
            onClick={() => setShowSections(!showSections)}
            className="w-full py-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className="inline-flex items-center gap-2">
              <List aria-hidden="true" className="w-3.5 h-3.5" />
              {showSections ? "Hide parts" : "Parts"}
            </span>
          </button>

          {showSections && (
            <div className="max-h-64 overflow-y-auto space-y-1 border border-border/50 rounded-lg p-2 mt-2">
              {Array.from({ length: job.total_sections || job.segments.length }, (_, index) => {
                const seg = [...job.segments!]
                  .sort((a, b) => a.index - b.index)
                  .find((s) => s.index === index);
                const isReady = Boolean(seg && seg.status === "ready");
                const canPlayRow = partRowCanPlay(job.status, isReady);
                const span = spans.find((item) => item.index === index);
                const isCurrent = liveAttached
                  ? Boolean(
                      span &&
                        currentTime + 0.05 >= span.startSeconds &&
                        currentTime < span.startSeconds + Math.max(span.durationSeconds, 0.05)
                    )
                  : Boolean(seg && audioUrl?.includes(seg.path));
                return (
                    <button
                      key={index}
                      onClick={() => {
                        if (!canPlayRow || !seg) return;
                        const rowSpan = spans.find((item) => item.index === seg.index);
                        const audio = audioRef.current;
                        const playingNow = true;
                        const target = rowSpan ? rowSpan.startSeconds : 0;
                        if (rowSpan) pinSection(rowSpan.index, rowSpan.startSeconds);
                        playbackResume.remember(
                          { positionSeconds: 0, sectionIndex: seg.index },
                          "track"
                        );
                        confirmedPlayheadRef.current = target;
                        const nextUrl = playbackUrlForStatus(
                          job.status,
                          `/api/storage/${seg.path}`
                        );
                        if (!nextUrl) return;
                        if (audio && liveSessionAttached(audio)) {
                          const covered = liveBufferedSeconds(audio);
                          const choice = rowSpan
                            ? chooseLivePart({
                                attached: true,
                                target,
                                covered,
                                sectionUrl: nextUrl,
                                playing: playingNow,
                              })
                            : { action: "section" as const, url: nextUrl, release: true, play: playingNow };
                          if (choice.action === "seek") {
                            audio.currentTime = choice.at;
                            retargetLiveResume(audio, choice.at, true);
                            confirmedPlayheadRef.current = choice.at;
                            waitingForNextRef.current = false;
                            setSegmentIndex(index);
                            setCurrentTime(choice.at);
                            listenerPausedRef.current = false;
                            if (choice.play) void audio.play().catch(() => {});
                            return;
                          }
                          releaseLiveSession(audio, rowSpan ? target : undefined);
                          listenerPausedRef.current = false;
                        }
                        armPendingSeekRef.current({
                          seconds: 0,
                          fraction: 0,
                          bookSeconds: rowSpan ? rowSpan.startSeconds : null,
                          sectionIndex: seg.index,
                        });
                        waitingForNextRef.current = false;
                        setSegmentIndex(index);
                        setCurrentTime(0);
                        playAfterLoadRef.current = true;
                        if (audioUrl === nextUrl && audio) {
                          audio.currentTime = 0;
                          if (playingNow) audio.play().catch(() => {});
                        } else {
                          setAudioUrl(nextUrl);
                        }
                      }}
                      disabled={!canPlayRow}
                      className={`w-full text-left px-3 py-2.5 rounded text-sm transition-all flex items-center gap-3 ${
                        isCurrent && canPlayRow
                          ? "bg-primary/10 text-primary font-medium"
                          : canPlayRow
                            ? "text-muted-foreground hover:text-foreground hover:bg-accent"
                            : "text-muted-foreground/40 cursor-not-allowed"
                      }`}
                    >
                      <span className="font-mono text-xs w-8">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="flex-1">
                        {partRowLabel(job.status, isReady)}
                      </span>
                      {isCurrent && isPlaying && (
                        <span className="flex gap-0.5 items-end h-3">
                          <span className="w-0.5 h-2 bg-primary animate-pulse" />
                          <span className="w-0.5 h-3 bg-primary animate-pulse" style={{ animationDelay: "0.15s" }} />
                          <span className="w-0.5 h-1.5 bg-primary animate-pulse" style={{ animationDelay: "0.3s" }} />
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* Download button — ready jobs or any with ready segments */}
      {(job.status === "ready" || job.segments?.some((s) => s.status === "ready")) &&
        job.job_kind !== "stream" && (
        <div className="mt-10 text-center">
          <button
            type="button"
            onClick={handleDownload}
            className="tap text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Download
          </button>
        </div>
      )}
    </div>
  );
}
