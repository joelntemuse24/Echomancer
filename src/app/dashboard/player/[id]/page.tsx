"use client";

import { ArrowLeft, Loader2, List } from "lucide-react";
import React, { useState, useEffect, useRef, use, useMemo, useCallback } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAudioProcessor } from "@/hooks/useAudioProcessor";
import { useAudiobookSession, type SessionActions } from "@/hooks/use-audiobook-session";
import { userFriendlyError } from "@/lib/errors-ui";
import { WaitMark } from "@/components/wait-mark";
import { EditableBookTitle } from "@/components/editable-book-title";
import { UX, WAIT } from "@/lib/ux-copy";
import {
  audiobookDownloadUrl,
  audiobookFilename,
  isIosDownload,
  startAudiobookDownload,
} from "@/lib/download-client";
import { shouldPollJob } from "@/lib/player/poll-schedule";
import { shouldReloadStorageAfterError } from "@/lib/player/storage-reload";
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
import {
  prepareChapterView,
  mediaSessionFields,
  type PlayerChapter,
} from "@/lib/player/chapter-nav";
import { PlayerSeekGroup } from "@/components/player-seek-group";
import { PlayerSpeedControl } from "@/components/player-speed-control";
import { PlayerTransport } from "@/components/player-transport";
import {
  NowPlayingLine,
  PlayerChapterSheet,
  useChapterListOpen,
} from "@/components/player-chapter-sheet";
import { ReadAlongTranscript } from "@/components/read-along-transcript";
import { ReadAlongFocus } from "@/components/read-along-focus";
import { useReadAlongFocus } from "@/hooks/use-read-along-focus";
import { usePreciseSeek } from "@/hooks/use-precise-seek";
import type { ReadAlongDocument, ReadAlongMode, ReadAlongPosition } from "@/lib/player/read-along";

/**
 * Storage URL with a version stamp. A browser reusing a cached redirect or
 * byte range from an older `full.mp3` would seek inside the wrong bytes.
 */
function versionedAudioUrl(
  url: string | null | undefined,
  updatedAt?: string | null
): string | null {
  if (!url) return null;
  if (!url.startsWith("/api/storage/")) return url;
  // No stamp to add: a bare `?v=` would only make the URL look versioned.
  if (!updatedAt) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(updatedAt)}`;
}

function readyByIndex(
  segments: Array<{ index: number; path: string; status: string }> | null | undefined
): Map<number, { index: number; path: string; status: string }> {
  const map = new Map<number, { index: number; path: string; status: string }>();
  for (const s of segments || []) {
    if (s.status === "ready" && s.path) map.set(s.index, s);
  }
  return map;
}

function canPlayIndex(
  segments: Array<{ index: number; path: string; status: string }> | null | undefined,
  index: number
): boolean {
  const ready = readyByIndex(segments);
  for (let i = 0; i <= index; i++) {
    if (!ready.has(i)) return false;
  }
  return true;
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
/** Generating book: first interval, and the interval right after a change. */
const JOB_POLL_MIN_MS = 4_000;
/** Generating book: slowest interval while nothing changes. */
const JOB_POLL_MAX_MS = 20_000;
const JOB_POLL_BACKOFF = 1.5;

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
  segments?: Array<{ index: number; path: string; status: string }> | null;
  chapters?: PlayerChapter[] | null;
  stream_chars_used?: number | null;
  stream_max_chars?: number | null;
  stream_cursor?: number | null;
  stream_timeline?: StreamTimeline | null;
}

export default function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <React.Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <PlayerPageInner params={params} />
    </React.Suspense>
  );
}

function PlayerPageInner({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const forceStream = searchParams.get("mode") === "stream";
  const forceSegments = searchParams.get("mode") === "segments";
  const audioRef = useRef<HTMLAudioElement>(null);
  const processorInitialized = useRef(false);

  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
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
  const [transcript, setTranscript] = useState<ReadAlongDocument | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState(false);
  const [transcriptRetry, setTranscriptRetry] = useState(0);
  const transcriptResource = useMemo(() => createTranscriptResource(id), [id]);
  const revision = useMemo(() => job ? transcriptRevision(job) : "", [job]);
  const playAfterLoadRef = useRef(false);
  /** Chapter seek to apply once the full file's metadata is loaded. */
  const pendingChapterSeekRef = useRef<{ seconds: number | null; fraction: number; charIndex?: number; document?: ReadAlongDocument } | null>(
    null
  );
  /** Last seek this page asked for, so a reload never returns to the old spot. */
  const lastRequestedSeekRef = useRef<number | null>(null);
  const waitingForNextRef = useRef(false);
  const storageReloadRef = useRef(0);
  const heardPlayingRef = useRef(false);

  // Reset all audio state when audiobook id changes
  useEffect(() => {
    setJob(null);
    setTranscript(null);
    setTranscriptError(false);
    setShowTranscript(false);
    // Focus mode is a remembered preference, so a different book keeps it.
    pendingChapterSeekRef.current = null;
    waitingForNextRef.current = false;
    segmentIndexRef.current = 0;
    setSegmentIndex(0);
    setStreamConn(null);
    setHeldStreamChar(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setAudioUrl(null);
    setError(null);
    processorInitialized.current = false;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current.load();
    }
  }, [id]);

  // Use ref for isDragging to avoid effect re-registration
  const isDraggingRef = useRef(false);
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  const { initialize, resume, setSpeed, speed } = useAudioProcessor();

  const openStreamUrl = useCallback((base: string) => {
    const conn = newStreamConn();
    setStreamConn(conn);
    return streamUrlWithConn(base, conn);
  }, []);

  // Fetch job data via REST API
  useEffect(() => {
    let stopped = false;
    async function fetchJob() {
      try {
        const response = await fetch(`/api/jobs/${id}`);
        if (!response.ok) throw new Error("Failed to fetch job");
        const data = await response.json();
        const j = data.job as Job;
        if (stopped) return;
        setJob(j);

        const isStream = forceStream || j.job_kind === "stream";
        if (isStream) {
          setAudioUrl(openStreamUrl(j.stream_url || `/api/jobs/${id}/stream`));
          return;
        }

        const first = readyByIndex(j.segments).get(0);
        if (first && (forceSegments || j.status === "processing" || !j.audio_url)) {
          setAudioUrl(`/api/storage/${first.path}`);
          setSegmentIndex(0);
          return;
        }

        if (j.audio_url) {
          setAudioUrl(versionedAudioUrl(j.audio_url, j.updated_at));
        } else if (first) {
          setAudioUrl(`/api/storage/${first.path}`);
          setSegmentIndex(0);
        }
      } catch (err) {
        if (stopped) return;
        console.error("Failed to fetch job:", err);
        setError("Couldn't load this audiobook.");
      }
    }

    void fetchJob();
    return () => { stopped = true; };
  }, [id, forceStream, forceSegments, openStreamUrl]);

  const audioUrlRef = useRef(audioUrl);
  useEffect(() => { audioUrlRef.current = audioUrl; }, [audioUrl]);

  // Polling for updates (adaptive, see below) - only re-render if data actually changed
  const jobRef = useRef<Job | null>(null);
  useEffect(() => { jobRef.current = job; }, [job]);
  useEffect(() => { segmentIndexRef.current = segmentIndex; }, [segmentIndex]);

  const jobStatus = job?.status;
  const jobKind = job?.job_kind;
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
    // now and then; a generating book starts brisk and backs off while
    // nothing changes. A hidden tab does not poll unless audio is playing
    // or the next section has not arrived yet, and it polls on return.
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
      const media = audioRef.current;
      if (
        typeof document !== "undefined" &&
        !shouldPollJob({
          visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
          playing: Boolean(media && !media.paused && !media.ended),
          waitingForNext: waitingForNextRef.current,
        })
      ) {
        schedule();
        return;
      }
      const changed = await poll();
      if (isStream) streamIdlePollsRef.current = changed ? 0 : streamIdlePollsRef.current + 1;
      if (!isStream) {
        delay = changed
          ? JOB_POLL_MIN_MS
          : Math.min(JOB_POLL_MAX_MS, Math.round(delay * JOB_POLL_BACKOFF));
      }
      schedule();
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
        const response = await fetch(`/api/jobs/${id}`);
        if (!response.ok) return false;
        const data = await response.json();
        if (stopped) return false;
        const prev = jobRef.current;
        const next = data.job as Job;

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
            JSON.stringify(prev.stream_timeline) !== JSON.stringify(next.stream_timeline) ||
            JSON.stringify(prev.segments) !== JSON.stringify(next.segments) ||
            JSON.stringify(prev.chapters) !== JSON.stringify(next.chapters)) {
          changed = true;
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

        if (next.audio_url && !audioUrlRef.current) {
          setAudioUrl(versionedAudioUrl(next.audio_url, next.updated_at));
        } else if (!audioUrlRef.current) {
          const first = readyByIndex(next.segments).get(0);
          if (first) {
            setSegmentIndex(0);
            setAudioUrl(`/api/storage/${first.path}`);
          }
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
  }, [id, jobStatus, jobKind, job?.audio_url, forceStream, forceSegments]);

  useEffect(() => {
    if (forceStream || forceSegments || jobStatus !== "ready" ||
        jobKind === "stream" || !job?.audio_url || !audioUrl?.includes("/sections/")) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const fullUrl = versionedAudioUrl(job.audio_url, job.updated_at)!;
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
        pendingChapterSeekRef.current = { seconds, fraction: 0 };
        playAfterLoadRef.current = Boolean(audio && (!audio.paused || waitingForNextRef.current));
        waitingForNextRef.current = false;
        setAudioUrl(fullUrl);
      } catch {
        if (stopped) return;
        if (++attempts < 3) timer = setTimeout(handoff, attempts * 2000);
        else {
          const fallbackFrac = (job.total_sections ?? 0) > 0 ? segmentIndexRef.current / job.total_sections : 0;
          pendingChapterSeekRef.current = { seconds: null, fraction: fallbackFrac };
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
    if (!waitingForNextRef.current || !job?.segments) return;
    const nextIndex = segmentIndex + 1;
    const next = readyByIndex(job.segments).get(nextIndex);
    if (next && canPlayIndex(job.segments, nextIndex)) {
      waitingForNextRef.current = false;
      setSegmentIndex(nextIndex);
      playAfterLoadRef.current = true;
      setAudioUrl(`/api/storage/${next.path}`);
    }
  }, [job, segmentIndex]);

  const handleSpawnTakehome = async () => {
    setSpawningTakehome(true);
    try {
      const res = await fetch(`/api/jobs/${id}/takehome`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setNotice(null);
      // Stay with the new take-home job so progress is visible immediately.
      router.push(`/dashboard/player/${data.jobId}`);
    } catch (e: unknown) {
      setNotice(userFriendlyError(e instanceof Error ? e.message : "Failed"));
    } finally {
      setSpawningTakehome(false);
    }
  };

  // Initialize audio processor when audio element is ready
  useEffect(() => {
    if (audioRef.current && audioUrl && !processorInitialized.current) {
      initialize(audioRef.current);
      processorInitialized.current = true;
    }
  }, [audioUrl, initialize]);

  useEffect(() => {
    storageReloadRef.current = 0;
    lastRequestedSeekRef.current = null;
  }, [audioUrl]);

  // HTML audio starts at 1×. Re-apply the active rate (1.15× until the
  // listener picks another) whenever the element or the choice changes.
  // Pitch correction is asked for explicitly: browsers default it on today,
  // but the narration voice is the product, and a rate that shifts pitch
  // would change the narrator rather than the tempo.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.defaultPlaybackRate = speed;
    audio.playbackRate = speed;
    audio.preservesPitch = true;
  }, [speed, audioUrl]);

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
    const onDurationChange = () => applyDuration(audio.duration);
    const onLoadedMetadata = () => {
      applyDuration(audio.duration);
      const pending = pendingChapterSeekRef.current;
      const total = effectiveDuration(audio.duration);
      if (pending != null && (total > 0 || pending.seconds != null)) {
        pendingChapterSeekRef.current = null;
        const raw = pending.charIndex != null && pending.document
          ? sectionSeekSeconds(pending.document, pending.charIndex, total) ?? 0
          : pending.seconds ?? pending.fraction * total;
        const seconds =
          total > 0 ? Math.min(raw, Math.max(0, total - 0.05)) : raw;
        lastRequestedSeekRef.current = seconds;
        audio.currentTime = seconds;
        setCurrentTime(seconds);
      }
    };
    const onCanPlay = () => {
      if (playAfterLoadRef.current) {
        playAfterLoadRef.current = false;
        audio.play().catch(() => {});
      }
    };
    const onEnded = () => {
      setIsPlaying(false);
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
        const nextIndex = current + 1;
        const next = readyByIndex(jobRef.current.segments).get(nextIndex);
        if (next && canPlayIndex(jobRef.current.segments, nextIndex)) {
          waitingForNextRef.current = false;
          setSegmentIndex(nextIndex);
          playAfterLoadRef.current = true;
          setAudioUrl(`/api/storage/${next.path}`);
        } else {
          waitingForNextRef.current = true;
        }
      }
    };
    const onPlay = () => {
      heardPlayingRef.current = true;
      setIsPlaying(true);
    };
    const onPause = () => {
      setIsPlaying(false);
      if (!audio.error) heardPlayingRef.current = false;
    };
    const onError = () => {
      const code = audio.error?.code ?? null;
      if (
        shouldReloadStorageAfterError({
          src: audioUrlRef.current,
          errorCode: code,
          alreadyReloaded: storageReloadRef.current >= 1,
        })
      ) {
        storageReloadRef.current += 1;
        // A reload during a seek must land on the requested spot, not on the
        // pre-seek playhead the element still reports.
        const at =
          lastRequestedSeekRef.current ??
          (Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
        pendingChapterSeekRef.current = { seconds: at, fraction: 0 };
        playAfterLoadRef.current =
          heardPlayingRef.current || at > 0.05;
        setIsPlaying(false);
        // src stays the same-origin storage path. load() asks for it again,
        // which mints a new signature. The element had been ranging against
        // the R2 URL from the previous redirect.
        audio.load();
        return;
      }
      pendingChapterSeekRef.current = null;
      setIsPlaying(false);
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
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
    };
  }, [audioUrl, forceStream, id, segmentIndex, openStreamUrl]);

  const togglePlayback = async () => {
    if (!audioRef.current || !audioUrl) return;

    // Resume audio context if suspended (browser policy)
    await resume();

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      try {
        await audioRef.current.play();
        setNotice(null);
      } catch {
        setNotice("Tap play again.");
      }
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

  const handleScrub = (seconds: number) => {
    if (isStreamMode) return;
    setCurrentTime(seconds);
  };

  const handleScrubCommit = (seconds: number) => {
    if (isStreamMode || !Number.isFinite(seconds)) return;
    const audio = audioRef.current;
    if (!audio) return;
    // Before metadata the element has no seekable range. Hold the seek and
    // let loadedmetadata apply it against the real file.
    if (audio.readyState < 1) {
      pendingChapterSeekRef.current = { seconds, fraction: 0 };
      setCurrentTime(seconds);
      return;
    }
    pendingChapterSeekRef.current = null;
    lastRequestedSeekRef.current = seconds;
    audio.currentTime = seconds;
    if (isPlaying) {
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
      pendingChapterSeekRef.current = { seconds: null, fraction: sectionFraction, charIndex, document: transcript };
      playAfterLoadRef.current = true;
      setSegmentIndex(seek.sectionIndex);
      setCurrentTime(0);
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
    if (!audio || audio.readyState < 1 || seconds == null) {
      pendingChapterSeekRef.current = onSection
        ? { seconds, fraction: sectionFraction, charIndex, document: transcript }
        : { seconds, fraction: seek.fraction };
      playAfterLoadRef.current = true;
      if (seconds != null) setCurrentTime(seconds);
      if (audio) audio.play().catch(() => { audio.load(); });
      return;
    }
    pendingChapterSeekRef.current = null;
    lastRequestedSeekRef.current = seconds;
    audio.currentTime = seconds;
    setCurrentTime(seconds);
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
    const pending = { seconds: chapter.startSeconds ?? null, fraction };
    if (full && audioUrl?.split("?")[0] !== full) {
      pendingChapterSeekRef.current = pending;
      playAfterLoadRef.current = true;
      setAudioUrl(versionedAudioUrl(full, job?.updated_at));
      if (targetSeconds != null) setCurrentTime(targetSeconds);
      return;
    }
    if (!audio || audio.readyState < 1 || targetSeconds == null) {
      pendingChapterSeekRef.current = pending;
      playAfterLoadRef.current = true;
      if (targetSeconds != null) setCurrentTime(targetSeconds);
      if (audio) {
        audio.play().catch(() => { audio.load(); });
      }
      return;
    }
    pendingChapterSeekRef.current = null;
    lastRequestedSeekRef.current = targetSeconds;
    audio.currentTime = targetSeconds;
    setCurrentTime(targetSeconds);
    if (audio.paused) {
      audio.play().catch(() => {});
    }
  };

  const handleSkip = (delta: number) => {
    if (isStreamMode || !audioRef.current) return;
    const next = clampSeekSeconds(
      audioRef.current.currentTime,
      delta,
      seekableDuration(audioRef.current.duration, playDuration)
    );
    audioRef.current.currentTime = next;
    setCurrentTime(next);
    if (isPlaying) {
      audioRef.current.play().catch(() => {});
    }
  };

  const applySpeed = useCallback(
    (next: number) => {
      setSpeed(next);
      const audio = audioRef.current;
      if (!audio) return;
      audio.defaultPlaybackRate = next;
      audio.playbackRate = next;
      audio.preservesPitch = true;
    },
    [setSpeed]
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

  const playDuration = duration > 0 ? duration : (job?.duration_seconds ?? 0);
  const chapterSource =
    job && job.status === "ready" && !isStreamMode ? (job.chapters ?? null) : null;
  const preparedChapters = useMemo(
    () => prepareChapterView(chapterSource, playDuration),
    [chapterSource, playDuration]
  );
  const view = preparedChapters(currentTime);
  const [chaptersOpen, toggleChapters] = useChapterListOpen(id);
  const chapterNav = view.enabled;
  const sessionActions = useRef<SessionActions>({
    play: () => {},
    pause: () => {},
    seekBy: () => {},
    seekTo: () => {},
    previous: () => {},
    next: () => {},
  });
  const chapterKeys = useRef({
    enabled: false,
    previous: () => {},
    next: () => {},
  });
  const skipTo = (target: { startFraction: number; startSeconds?: number } | null) => {
    if (target) openChapter(target);
  };
  sessionActions.current = {
    play: () => {
      if (audioRef.current?.paused) void togglePlayback();
    },
    pause: () => {
      audioRef.current?.pause();
    },
    seekBy: handleSkip,
    seekTo: handleScrubCommit,
    previous: () => skipTo(view.previous),
    next: () => skipTo(view.next),
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
  useAudiobookSession({
    active: Boolean(audioUrl),
    title: sessionMeta.title,
    artist: sessionMeta.artist,
    album: sessionMeta.album,
    duration: playDuration,
    position: currentTime,
    playbackRate: speed,
    playing: isPlaying,
    seekable: Boolean(audioUrl) && !isStreamMode,
    chapterSkip: chapterNav,
    actions: sessionActions,
  });

  if (error) {
    return (
      <div className="max-w-2xl mx-auto pt-8 pb-20 text-center space-y-4">
        <p className="text-sm text-muted-foreground">{error}</p>
        <button
          type="button"
          onClick={() => router.push("/dashboard/queue")}
          className="tap text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Library
        </button>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const panelOpen = chaptersOpen && chapterNav;

  return (
    <div className={panelOpen ? "md:pr-80" : undefined}>
    <div className="mx-auto w-full max-w-2xl pt-8 pb-20 font-sans md:pt-6 md:pb-12">
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="auto"
        />
      )}

      {/* Back button */}
      <Link
        href="/dashboard/queue"
        className="tap inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors mb-8 md:mb-4"
      >
        <ArrowLeft aria-hidden="true" className="w-3.5 h-3.5" />
        Library
      </Link>

      <div className="md:flex md:min-h-[min(32rem,calc(100dvh-14rem))] md:flex-col md:justify-center">
        <div className="mb-10 space-y-2 text-center md:mb-14">
        <div className="flex min-w-0 items-center justify-center gap-1 px-4">
          <EditableBookTitle
            jobId={job.id}
            title={job.book_title}
            onRenamed={(title) =>
              setJob((prev) => (prev ? { ...prev, book_title: title } : prev))
            }
            inputClassName="text-center font-serif text-4xl tracking-tight md:text-5xl"
          >
            <h1
              className="min-w-0 truncate font-serif text-4xl tracking-tight text-foreground md:text-5xl"
              style={{ fontWeight: 300 }}
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
        {(job.status === "processing" ||
          job.status === "queued" ||
          job.status === "waiting") &&
        job.progress < 100 ? (
          <p className="text-xs text-muted-foreground" role="status">
            <WaitMark phrases={job.waiting_for_text ? WAIT.ingest : WAIT.generating} />
          </p>
        ) : null}
        {job.status === "failed" ? (
          <p className="text-xs text-muted-foreground" role="alert">
            {job.error_message
              ? userFriendlyError(job.error_message)
              : UX.failed}
          </p>
        ) : job.warning ? (
          <p className="text-xs text-muted-foreground" role="status">
            {userFriendlyError(String(job.warning))}
          </p>
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

        {audioUrl ? (
          <>
            <PlayerSeekGroup
              currentTime={currentTime}
              duration={playDuration}
              disabled={isStreamMode}
              fineVisible={preciseSeek}
              onFineVisibleChange={setPreciseSeek}
              ticks={chapterNav ? view.ticks : undefined}
              chapterLabel={chapterNav ? view.dragLabel : null}
              onScrub={handleScrub}
              onScrubCommit={handleScrubCommit}
              onScrubActiveChange={setIsDragging}
            />
            <PlayerSpeedControl
              speed={speed}
              onSpeedChange={applySpeed}
            />
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
              onSeek={isStreamMode ? undefined : seekToChar}
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
          onSeek={isStreamMode ? undefined : seekToChar}
          bookTitle={job.book_title}
          chapterTitle={chapterNav ? view.dragLabel : null}
          playing={isPlaying}
          speed={speed}
          currentTime={currentTime}
          duration={playDuration}
          streamMode={isStreamMode}
          onToggle={() => {
            void togglePlayback();
          }}
          onClose={() => setFocus(false)}
          onSkip={(delta) => {
            // Focus mode is the only place the player bar leaves the page,
            // so it carries the whole transport, including sections.
            if (readAlongMode === "section") {
              const audio = audioRef.current;
              if (!audio) return;
              const next = clampSeekSeconds(
                audio.currentTime,
                delta,
                seekableDuration(audio.duration, playDuration)
              );
              audio.currentTime = next;
              setCurrentTime(next);
              if (isPlaying) audio.play().catch(() => {});
              return;
            }
            handleSkip(delta);
          }}
          onScrub={handleScrub}
          onScrubCommit={handleScrubCommit}
          onScrubActiveChange={setIsDragging}
          onSpeedChange={applySpeed}
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
                const isCurrent = seg ? audioUrl?.includes(seg.path) : false;
                return (
                    <button
                      key={index}
                      onClick={() => {
                        if (isReady && seg) {
                          pendingChapterSeekRef.current = null;
                          waitingForNextRef.current = false;
                          setSegmentIndex(index);
                          setCurrentTime(0);
                          playAfterLoadRef.current = true;
                          const nextUrl = `/api/storage/${seg.path}`;
                          if (audioUrl === nextUrl && audioRef.current) {
                            audioRef.current.currentTime = 0;
                            audioRef.current.play().catch(() => {});
                          } else {
                            setAudioUrl(nextUrl);
                          }
                        }
                      }}
                      disabled={!isReady}
                      className={`w-full text-left px-3 py-2.5 rounded text-sm transition-all flex items-center gap-3 ${
                        isCurrent
                          ? "bg-primary/10 text-primary font-medium"
                          : isReady
                            ? "text-muted-foreground hover:text-foreground hover:bg-accent"
                            : "text-muted-foreground/40 cursor-not-allowed"
                      }`}
                    >
                      <span className="font-mono text-xs w-8">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="flex-1">
                        {isReady ? "Ready" : "Generating…"}
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
    </div>
  );
}
