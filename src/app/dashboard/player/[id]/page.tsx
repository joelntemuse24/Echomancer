"use client";

import { Slider } from "@/components/ui/slider";
import { Loader2 } from "lucide-react";
import React, { useState, useEffect, useRef, use } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAudioProcessor } from "@/hooks/useAudioProcessor";
import { userFriendlyError } from "@/lib/errors-ui";
import { EditableBookTitle } from "@/components/editable-book-title";
import { ProgressLine } from "@/components/progress-line";
import { UX } from "@/lib/ux-copy";
import {
  audiobookFilename,
  isIosDownload,
  startAudiobookDownload,
} from "@/lib/download-client";
import type { PlaybackChapter } from "@/lib/player/playback-chapters";
import { SKIP_SECONDS, clampSeekSeconds, fineSeekBounds } from "@/lib/player/seek";
import { PlayerSpeedControl } from "@/components/player-speed-control";
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

function PlayMark({ playing }: { playing: boolean }) {
  return playing ? (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
      <path d="M9 6.5v11M15 6.5v11" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
      <path d="M8.5 6.2v11.6L17.8 12 8.5 6.2z" />
    </svg>
  );
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

interface Job {
  id: string;
  book_title: string;
  voice_name: string | null;
  status: "queued" | "processing" | "ready" | "failed" | "cancelled";
  progress: number;
  current_section: number;
  total_sections: number;
  audio_url?: string | null;
  duration_seconds: number | null;
  error_message: string | null;
  warning?: string | null;
  created_at: string;
  updated_at: string;
  job_kind?: string | null;
  tts_provider?: string | null;
  stream_url?: string;
  segments?: Array<{ index: number; path: string; status: string }> | null;
  chapters?: PlaybackChapter[] | null;
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
  const [fineLock, setFineLock] = useState<{ start: number; end: number } | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [transcript, setTranscript] = useState<ReadAlongDocument | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const playAfterLoadRef = useRef(false);
  /** Fraction of the full file to apply once that file's metadata is loaded. */
  const pendingChapterSeekRef = useRef<number | null>(null);
  const waitingForNextRef = useRef(false);

  // Reset all audio state when audiobook id changes
  useEffect(() => {
    setJob(null);
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

  // Polling for updates (every 3 seconds) - only re-render if data actually changed
  const jobRef = useRef<Job | null>(null);
  useEffect(() => { jobRef.current = job; }, [job]);
  useEffect(() => { segmentIndexRef.current = segmentIndex; }, [segmentIndex]);

  const jobStatus = job?.status;
  const jobKind = job?.job_kind;
  useEffect(() => {
    if (!jobStatus) return;
    const isStream = forceStream || jobKind === "stream";
    // Poll take-home while generating; also poll streams for budget/status.
    if (
      !isStream &&
      (jobStatus === "ready" ||
        jobStatus === "failed" ||
        jobStatus === "cancelled")
    ) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${id}`);
        if (!response.ok) return;
        const data = await response.json();
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
            prev.stream_chars_used !== next.stream_chars_used ||
            prev.stream_max_chars !== next.stream_max_chars ||
            prev.stream_cursor !== next.stream_cursor ||
            JSON.stringify(prev.segments) !== JSON.stringify(next.segments)) {
          setJob(next);
        }

        if (isStream) {
          const used = next.stream_chars_used ?? 0;
          const max = next.stream_max_chars ?? 0;
          if (max > 0 && used >= max) {
            setStreamEnded(true);
          }
          return;
        }

        if (next.audio_url && !audioUrlRef.current) {
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
    }, 3000);

    return () => clearInterval(interval);
  }, [id, jobStatus, jobKind, forceStream]);

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

    const onTimeUpdate = () => {
      if (!isDraggingRef.current) setCurrentTime(audio.currentTime);
    };
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onLoadedMetadata = () => {
      setDuration(audio.duration || 0);
      const pending = pendingChapterSeekRef.current;
      if (pending != null && audio.duration > 0) {
        pendingChapterSeekRef.current = null;
        const seconds = pending * audio.duration;
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
      if (jobRef.current?.segments?.length) {
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

  const handleSeekChange = (value: number[]) => {
    if (isStreamMode) return;
    setIsDragging(true);
    setCurrentTime(value[0] ?? 0);
  };

  const handleSeekCommit = (value: number[]) => {
    if (isStreamMode) {
      setIsDragging(false);
      return;
    }
    const seekTo = value[0] ?? 0;
    if (audioRef.current) {
      audioRef.current.currentTime = seekTo;
      if (isPlaying) {
        audioRef.current.play().catch(() => {});
      }
    }
    setIsDragging(false);
  };

  const openChapter = (startFraction: number) => {
    if (isStreamMode) return;
    const fraction = Math.min(1, Math.max(0, startFraction));
    const full = job?.audio_url;
    const audio = audioRef.current;
    const knownDuration =
      audio && Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : duration;
    if (full && audioUrl !== full) {
      pendingChapterSeekRef.current = fraction;
      playAfterLoadRef.current = true;
      setAudioUrl(full);
      if (knownDuration > 0) setCurrentTime(fraction * knownDuration);
      return;
    }
    if (!audio || audio.readyState < 1 || !(knownDuration > 0)) {
      pendingChapterSeekRef.current = fraction;
      return;
    }
    pendingChapterSeekRef.current = null;
    const seconds = fraction * knownDuration;
    audio.currentTime = seconds;
    setCurrentTime(seconds);
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
        `/api/jobs/${job.id}/download`,
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

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds) || seconds < 0) return "0:00";
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const clock = `${mins}:${secs.toString().padStart(2, "0")}`;
    return hours > 0 ? `${hours}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}` : clock;
  };

  const quiet =
    "inline-flex min-h-11 items-center text-sm text-muted-foreground transition-colors hover:text-foreground";

  if (error) {
    return (
      <div className="mx-auto max-w-md pt-8 text-center">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Link href="/dashboard/queue" className={quiet}>
          Library
        </Link>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const chapterList =
    job.status === "ready" && !isStreamMode && (job.chapters?.length ?? 0) > 0
      ? job.chapters!
      : null;
  const fineWindow = isStreamMode
    ? null
    : fineLock ?? fineSeekBounds(currentTime, duration);
  const chapterSeconds = (chapter: PlaybackChapter): number | null =>
    duration > 0 ? chapter.startFraction * duration : null;
  const activeChapter =
    chapterList && duration > 0
      ? chapterList.reduce<PlaybackChapter | null>((current, chapter) => {
          const start = chapter.startFraction * duration;
          return currentTime >= start - 0.05 ? chapter : current;
        }, null) ?? chapterList[0]
      : null;
  const generating =
    !audioUrl && (job.status === "processing" || job.status === "queued");
  const partList =
    !chapterList &&
    !forceStream &&
    job.job_kind !== "stream" &&
    (job.total_sections > 0 || (job.segments?.length ?? 0) > 0);

  const chapterBlock = chapterList ? (
    <div className="mt-2 w-full text-left">
      {showSections ? (
        <ul className="mx-auto max-h-64 max-w-sm space-y-1 overflow-y-auto">
          {chapterList.map((chapter) => {
            const isCurrent = activeChapter?.index === chapter.index;
            const start = chapterSeconds(chapter);
            return (
              <li key={chapter.index}>
                <button
                  type="button"
                  onClick={() => openChapter(chapter.startFraction)}
                  aria-current={isCurrent ? "true" : undefined}
                  className={`flex min-h-11 w-full items-baseline justify-between gap-4 text-left text-sm ${
                    isCurrent ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span className="truncate">{chapter.title}</span>
                  <span className="shrink-0 text-xs tabular-nums">
                    {start == null ? "" : formatTime(start)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  ) : null;

  const partsBlock = partList ? (
    <div className="mt-2 w-full text-left">
      {showSections ? (
        <ul className="mx-auto max-h-64 max-w-sm space-y-1 overflow-y-auto">
          {Array.from({ length: job.total_sections || job.segments?.length || 0 }, (_, index) => {
            const seg = [...(job.segments || [])]
              .sort((a, b) => a.index - b.index)
              .find((s) => s.index === index);
            const isReady = Boolean(seg && seg.status === "ready" && canPlayIndex(job.segments, index));
            const isCurrent = seg ? audioUrl?.includes(seg.path) : false;
            return (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => {
                    if (isReady && seg) {
                      setSegmentIndex(index);
                      playAfterLoadRef.current = true;
                      setAudioUrl(`/api/storage/${seg.path}`);
                    }
                  }}
                  disabled={!isReady}
                  className={`flex min-h-11 w-full items-center text-left text-sm disabled:cursor-not-allowed ${
                    isCurrent
                      ? "text-foreground"
                      : isReady
                        ? "text-muted-foreground hover:text-foreground"
                        : "text-muted-foreground/40"
                  }`}
                >
                  {isReady ? "Ready" : "Generating…"}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  ) : null;

  if (generating) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center pt-8 text-center">
        <h1 className="font-serif text-5xl font-light tracking-tight text-foreground sm:text-6xl">
          {UX.makingTitle}
        </h1>
        <p className="mt-8 max-w-full truncate text-sm text-muted-foreground">{job.book_title}</p>
        <div className="mt-16 w-full">
          <ProgressLine value={job.progress} label="Audiobook progress" />
        </div>
        <p className="mt-4 text-sm text-muted-foreground">{job.progress}%</p>
        {partList ? (
          <button
            type="button"
            aria-expanded={showSections}
            onClick={() => setShowSections(!showSections)}
            className={`mt-8 ${quiet}`}
          >
            {UX.parts}
          </button>
        ) : null}
        {partsBlock}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
      {audioUrl ? (
        <audio ref={audioRef} src={audioUrl} preload="auto" />
      ) : null}

      <Link href="/dashboard/queue" className={quiet}>
        Library
      </Link>

      <div className="mt-10 flex w-full min-w-0 flex-col items-center px-2">
        <EditableBookTitle
          jobId={job.id}
          title={job.book_title}
          onRenamed={(title) =>
            setJob((prev) => (prev ? { ...prev, book_title: title } : prev))
          }
          inputClassName="text-center font-serif text-4xl font-light tracking-tight sm:text-5xl"
          buttonClassName="text-xs"
        >
          <h1 className="w-full text-balance text-center font-serif text-4xl font-light tracking-tight text-foreground sm:text-5xl">
            {job.book_title}
          </h1>
        </EditableBookTitle>
      </div>
      {job.voice_name ? (
        <p className="mt-3 text-sm text-muted-foreground">{job.voice_name}</p>
      ) : null}
      {(job.status === "processing" || job.status === "queued") && job.progress < 100 ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {job.progress}%
        </p>
      ) : null}
      {job.status === "failed" ? (
        <p className="mt-3 text-sm text-muted-foreground" role="alert">
          {job.error_message ? userFriendlyError(job.error_message) : UX.failed}
        </p>
      ) : job.warning ? (
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          {userFriendlyError(String(job.warning))}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-3 text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}

      {(forceStream || job.job_kind === "stream") && (
        <div className="mt-8 space-y-2">
          {streamEnded ? (
            <p className="text-xs text-muted-foreground">{UX.listeningPaused}</p>
          ) : null}
          <button
            type="button"
            disabled={spawningTakehome}
            onClick={handleSpawnTakehome}
            className={`${quiet} disabled:opacity-40`}
          >
            {spawningTakehome ? UX.fullBookStarted : UX.saveFullBook}
          </button>
        </div>
      )}

      {audioUrl ? (
        <div className="mt-12 w-full">
          <Slider
            line
            aria-label="Seek"
            value={[currentTime]}
            onValueChange={handleSeekChange}
            onValueCommit={handleSeekCommit}
            min={0}
            max={duration || 1}
            step={0.1}
            disabled={isStreamMode}
            className={isStreamMode ? "cursor-not-allowed opacity-40" : "cursor-pointer"}
          />
          <div className="mt-2 flex items-center justify-between text-xs tabular-nums text-muted-foreground">
            <span>{formatTime(currentTime)}</span>
            <span>{isStreamMode ? "—" : formatTime(duration)}</span>
          </div>
          {fineWindow ? (
            <div className="space-y-1 pt-4">
              <p className="text-center text-xs text-muted-foreground">
                Fine tune {formatTime(fineWindow.start)}–{formatTime(fineWindow.end)}
              </p>
              <Slider
                line
                aria-label="Fine tune"
                value={[Math.min(fineWindow.end, Math.max(fineWindow.start, currentTime))]}
                onValueChange={(value) => {
                  setFineLock((prev) => prev ?? fineSeekBounds(currentTime, duration));
                  handleSeekChange(value);
                }}
                onValueCommit={(value) => {
                  handleSeekCommit(value);
                  setFineLock(null);
                }}
                onPointerCancel={() => {
                  setFineLock(null);
                  setIsDragging(false);
                }}
                min={fineWindow.start}
                max={fineWindow.end}
                step={1}
                className="w-full cursor-pointer"
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-8 flex items-center gap-6 sm:gap-10">
        {audioUrl ? (
          <button
            type="button"
            aria-label="Back 10 seconds"
            onClick={() => handleSkip(-SKIP_SECONDS)}
            disabled={isStreamMode}
            className={`${quiet} disabled:cursor-not-allowed disabled:opacity-30`}
          >
            {UX.previous}
          </button>
        ) : (
          <span className="min-w-16" />
        )}
        <button
          type="button"
          onClick={togglePlayback}
          disabled={!audioUrl}
          aria-label={isPlaying ? "Pause" : "Play"}
          className="flex h-14 w-14 items-center justify-center rounded-full border border-foreground/80 text-foreground transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <PlayMark playing={isPlaying} />
        </button>
        {audioUrl ? (
          <button
            type="button"
            aria-label="Forward 10 seconds"
            onClick={() => handleSkip(SKIP_SECONDS)}
            disabled={isStreamMode}
            className={`${quiet} disabled:cursor-not-allowed disabled:opacity-30`}
          >
            {UX.next}
          </button>
        ) : (
          <span className="min-w-16" />
        )}
      </div>

      {audioUrl ? (
        <div className="mt-4">
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
        </div>
      ) : null}

      <div className="mt-6 flex items-center gap-8">
        {chapterList || partList ? (
          chapterList ? (
            <button
              type="button"
              aria-expanded={showSections}
              onClick={() => setShowSections(!showSections)}
              className={quiet}
            >
              {UX.chapters}
            </button>
          ) : (
            <button
              type="button"
              aria-expanded={showSections}
              onClick={() => setShowSections(!showSections)}
              className={quiet}
            >
              {UX.parts}
            </button>
          )
        ) : null}
        <button
          type="button"
          aria-expanded={showTranscript}
          onClick={() => {
            void openTranscript();
          }}
          className={quiet}
        >
          {UX.readAlong}
        </button>
      </div>

      {showTranscript ? (
        <div className="mt-6 w-full">
          {transcriptLoading || !transcript ? (
            <p className="text-sm text-muted-foreground">Opening…</p>
          ) : (
            <ReadAlongTranscript
              document={transcript}
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

      {showSections ? (chapterList ? chapterBlock : partsBlock) : null}

      {(job.status === "ready" || job.segments?.some((s) => s.status === "ready")) &&
      job.job_kind !== "stream" ? (
        <button type="button" onClick={handleDownload} className={`mt-6 ${quiet}`}>
          Download
        </button>
      ) : null}
    </div>
  );
}
