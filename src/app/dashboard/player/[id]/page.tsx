"use client";

import { ArrowLeft, Loader2, List } from "lucide-react";
import React, { useState, useEffect, useRef, use, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAudioProcessor } from "@/hooks/useAudioProcessor";
import { useAudiobookSession, type SessionActions } from "@/hooks/use-audiobook-session";
import { userFriendlyError } from "@/lib/errors-ui";
import { WaitMark } from "@/components/wait-mark";
import { EditableBookTitle } from "@/components/editable-book-title";
import { UX, WAIT } from "@/lib/ux-copy";
import {
  audiobookFilename,
  isIosDownload,
  startAudiobookDownload,
} from "@/lib/download-client";
import { passageSeekForChar } from "@/lib/player/read-along";
import { clampSeekSeconds, FINE_SEEK_ALWAYS_SECONDS } from "@/lib/player/seek";
import {
  chapterView,
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
import type { ReadAlongDocument, ReadAlongMode } from "@/lib/player/read-along";

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
  /** Last playback or action problem, shown quietly under the title. */
  const [notice, setNotice] = useState<string | null>(null);
  const [showSections, setShowSections] = useState(false);
  /** Fine tune is up: long audio lifts it on load, a scrub lifts it otherwise. */
  const [fineVisible, setFineVisible] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [transcript, setTranscript] = useState<ReadAlongDocument | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const playAfterLoadRef = useRef(false);
  /** Chapter seek to apply once the full file's metadata is loaded. */
  const pendingChapterSeekRef = useRef<{ seconds: number | null; fraction: number } | null>(
    null
  );
  const waitingForNextRef = useRef(false);

  // Reset all audio state when audiobook id changes
  useEffect(() => {
    setJob(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setFineVisible(false);
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

  // Fetch job data via REST API
  useEffect(() => {
    async function fetchJob() {
      try {
        const response = await fetch(`/api/jobs/${id}`);
        if (!response.ok) throw new Error("Failed to fetch job");
        const data = await response.json();
        const j = data.job as Job;
        setJob(j);

        const isStream = forceStream || j.job_kind === "stream";
        if (isStream) {
          setAudioUrl(j.stream_url || `/api/jobs/${id}/stream`);
          return;
        }

        const first = readyByIndex(j.segments).get(0);
        if (first && (forceSegments || j.status === "processing" || !j.audio_url)) {
          setAudioUrl(`/api/storage/${first.path}`);
          setSegmentIndex(0);
          return;
        }

        if (j.audio_url) {
          setAudioUrl(j.audio_url);
        } else if (first) {
          setAudioUrl(`/api/storage/${first.path}`);
          setSegmentIndex(0);
        }
      } catch (err) {
        console.error("Failed to fetch job:", err);
        setError("Couldn't load this audiobook.");
      }
    }

    fetchJob();
  }, [id, forceStream, forceSegments]);

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
    // nothing changes. A hidden tab does not poll, and polls on return.
    let delay = isStream ? STREAM_POLL_MS : JOB_POLL_MIN_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, delay);
    };

    const tick = async () => {
      if (stopped) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        schedule();
        return;
      }
      const changed = await poll();
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

        if (
          !forceSegments &&
          next.status === "ready" &&
          next.audio_url &&
          audioUrlRef.current?.includes("/sections/")
        ) {
          const audio = audioRef.current;
          const local = audio?.currentTime ?? 0;
          const localDur =
            audio && Number.isFinite(audio.duration) && audio.duration > 0
              ? audio.duration
              : 0;
          const total = Math.max(1, next.total_sections || next.segments?.length || 1);
          const into = localDur > 0 ? Math.min(1, Math.max(0, local) / localDur) : 0;
          pendingChapterSeekRef.current = {
            seconds: null,
            fraction: Math.min(0.999, (segmentIndexRef.current + into) / total),
          };
          playAfterLoadRef.current = Boolean(audio && !audio.paused);
          setAudioUrl(next.audio_url);
        } else if (next.audio_url && !audioUrlRef.current) {
          setAudioUrl(next.audio_url);
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

  // HTML audio starts at 1×. Re-apply the active rate (1.15× until the
  // listener picks another) whenever the element or the choice changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.defaultPlaybackRate = speed;
    audio.playbackRate = speed;
  }, [speed, audioUrl]);

  // Audio event listeners
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const applyDuration = (raw: number) => {
      const next = raw || 0;
      setDuration(next);
      // Long audio lifts fine tune from load; once lifted it never drops.
      if (next >= FINE_SEEK_ALWAYS_SECONDS) setFineVisible(true);
    };
    const onTimeUpdate = () => {
      if (!isDraggingRef.current) setCurrentTime(audio.currentTime);
    };
    const onDurationChange = () => applyDuration(audio.duration);
    const onLoadedMetadata = () => {
      applyDuration(audio.duration);
      const pending = pendingChapterSeekRef.current;
      if (pending != null && (audio.duration > 0 || pending.seconds != null)) {
        pendingChapterSeekRef.current = null;
        const raw = pending.seconds ?? pending.fraction * audio.duration;
        const seconds =
          audio.duration > 0 ? Math.min(raw, Math.max(0, audio.duration - 0.05)) : raw;
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
          const nextUrl = `/api/jobs/${id}/stream?t=${Date.now()}`;
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
      setIsPlaying(true);
    };
    const onPause = () => setIsPlaying(false);
    const onError = () => {
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
  }, [audioUrl, forceStream, id, segmentIndex]);

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

  const handleScrub = (seconds: number) => {
    if (isStreamMode) return;
    setCurrentTime(seconds);
  };

  const handleScrubCommit = (seconds: number) => {
    if (isStreamMode) return;
    if (audioRef.current) {
      audioRef.current.currentTime = seconds;
      if (isPlaying) {
        audioRef.current.play().catch(() => {});
      }
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
    const onSection = Boolean(audioUrl?.includes("/sections/"));
    if (onSection && seek.sectionIndex != null && seek.sectionIndex !== segmentIndex) {
      const seg = readyByIndex(job?.segments).get(seek.sectionIndex);
      if (!seg || !canPlayIndex(job?.segments, seek.sectionIndex)) return;
      const local =
        seek.sectionSeconds ??
        (knownDuration > 0 ? seek.fraction * knownDuration : 0);
      pendingChapterSeekRef.current = { seconds: local, fraction: seek.fraction };
      playAfterLoadRef.current = true;
      setSegmentIndex(seek.sectionIndex);
      setCurrentTime(local);
      setAudioUrl(`/api/storage/${seg.path}`);
      return;
    }
    const seconds = onSection
      ? (seek.sectionSeconds ?? (knownDuration > 0 ? seek.fraction * knownDuration : null))
      : (seek.fullSeconds ?? (knownDuration > 0 ? seek.fraction * knownDuration : null));
    if (!audio || seconds == null) {
      pendingChapterSeekRef.current = { seconds, fraction: seek.fraction };
      return;
    }
    audio.currentTime = seconds;
    setCurrentTime(seconds);
    if (audio.paused) audio.play().catch(() => {});
  };

  const openChapter = (chapter: { startFraction: number; startSeconds?: number }) => {
    if (isStreamMode) return;
    const fraction = Math.min(1, Math.max(0, chapter.startFraction));
    const full = job?.audio_url;
    const audio = audioRef.current;
    const knownDuration =
      audio && Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : duration;
    const targetSeconds =
      chapter.startSeconds != null
        ? chapter.startSeconds
        : knownDuration > 0
          ? fraction * knownDuration
          : null;
    const pending = { seconds: chapter.startSeconds ?? null, fraction };
    if (full && audioUrl !== full) {
      pendingChapterSeekRef.current = pending;
      playAfterLoadRef.current = true;
      setAudioUrl(full);
      if (targetSeconds != null) setCurrentTime(targetSeconds);
      return;
    }
    if (!audio || audio.readyState < 1 || targetSeconds == null) {
      pendingChapterSeekRef.current = pending;
      return;
    }
    pendingChapterSeekRef.current = null;
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
      audioRef.current.duration || duration
    );
    audioRef.current.currentTime = next;
    setCurrentTime(next);
    if (isPlaying) {
      audioRef.current.play().catch(() => {});
    }
  };

  const handleDownload = () => {
    if (!job) return;
    try {
      startAudiobookDownload(
        job.download_url || `/api/jobs/${job.id}/download`,
        audiobookFilename(job.book_title)
      );
      setNotice(isIosDownload() ? UX.downloadOpened : null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Download failed. Try again.");
    }
  };

  const openTranscript = async () => {
    const next = !showTranscript;
    setShowTranscript(next);
    if (!next || transcript || transcriptLoading) return;
    setTranscriptLoading(true);
    try {
      const response = await fetch(`/api/jobs/${id}/transcript`);
      if (!response.ok) throw new Error("unavailable");
      const data = (await response.json()) as ReadAlongDocument;
      setTranscript(data);
    } catch {
      setTranscript({ blocks: [], charCount: 0, sections: [] });
    } finally {
      setTranscriptLoading(false);
    }
  };

  const playDuration = duration > 0 ? duration : (job?.duration_seconds ?? 0);
  const chapterSource =
    job && job.status === "ready" && !isStreamMode ? (job.chapters ?? null) : null;
  const view = useMemo(
    () => chapterView(chapterSource, currentTime, playDuration),
    [chapterSource, currentTime, playDuration]
  );
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
              duration={duration}
              disabled={isStreamMode}
              fineVisible={fineVisible}
              ticks={chapterNav ? view.ticks : undefined}
              chapterLabel={chapterNav ? view.dragLabel : null}
              onFineReveal={() => setFineVisible(true)}
              onScrub={handleScrub}
              onScrubCommit={handleScrubCommit}
              onScrubActiveChange={setIsDragging}
            />
            <PlayerSpeedControl
              speed={speed}
              onSpeedChange={(next) => {
                setSpeed(next);
                if (audioRef.current) {
                  audioRef.current.defaultPlaybackRate = next;
                  audioRef.current.playbackRate = next;
                }
              }}
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

      {showTranscript ? (
        <div className="mt-4 mb-8">
          {transcriptLoading || !transcript ? (
            <p className="text-center text-sm text-muted-foreground">Opening…</p>
          ) : (
            <ReadAlongTranscript
              document={transcript}
              onSeek={seekToChar}
              position={{
                mode: readAlongMode,
                currentTime,
                duration,
                sectionIndex: readAlongMode === "section" ? segmentIndex : null,
                streamCursor:
                  typeof job.stream_cursor === "number" ? job.stream_cursor : null,
              }}
            />
          )}
        </div>
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
                const isReady = Boolean(seg && seg.status === "ready" && canPlayIndex(job.segments, index));
                const isCurrent = seg ? audioUrl?.includes(seg.path) : false;
                return (
                    <button
                      key={index}
                      onClick={() => {
                        if (isReady && seg) {
                          setSegmentIndex(index);
                          playAfterLoadRef.current = true;
                          setAudioUrl(`/api/storage/${seg.path}`);
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
