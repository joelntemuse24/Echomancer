"use client";

import { Button } from "@/components/ui/button";
import {
  DrawablyButton,
  DrawablyCard,
  DrawablyInput,
  DrawablyTabs,
} from "drawably/react";
import { sketchSeed } from "@/lib/sketch-seed";
import {
  Loader2,
  ArrowLeft,
  Headphones,
  Download,
  Play,
  Square,
  RotateCcw,
  Mic,
  Trash2,
} from "lucide-react";
import { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { userFriendlyError } from "@/lib/errors-ui";
import { uploadCloneVoice } from "@/lib/upload-client";
import { maxCloneSampleMb } from "@/lib/clone-sample-formats";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";
import { sniffPreviewMime } from "@/lib/tts/preview-text";
import { UX } from "@/lib/ux-copy";

type AccentId = "american" | "british" | "australian" | "irish" | "other";
type VibeId = "calm" | "warm" | "upbeat" | "smooth" | "dramatic" | "clear";

interface CatalogVoice {
  id: string;
  provider?: string;
  displayName: string;
  friendlyName?: string;
  personaLabel?: string;
  accent?: AccentId;
  vibe?: VibeId;
  language: string;
  locale: string;
  gender: string;
  style: string;
  tags: string[];
  model: string;
  latencyClass: string;
  listenRecommended?: boolean;
  priceEstimate?: {
    suggestedPriceEur: number;
    estimatedAudioHours: number;
    targetPriceEur: number;
  } | null;
  generationEta?: {
    sections: number;
    seconds: number;
    label: string | null;
  } | null;
}

type Intent = "listen" | "full";

type RecentVoice = {
  id: string;
  name: string;
  meta: string;
  at: number;
};

const RECENT_KEY = "echomancer:recent-voices";

function voiceTitle(v: CatalogVoice): string {
  return v.friendlyName || v.displayName;
}

function voiceMeta(v: CatalogVoice): string {
  if (v.personaLabel) return v.personaLabel;
  return `${v.locale} · ${v.gender} · ${v.style}`;
}

function isClonedVoice(v: CatalogVoice): boolean {
  return (
    v.provider === "fish" ||
    v.id.startsWith("clone:") ||
    v.tags.some((t) => t.toLowerCase() === "cloned")
  );
}

/** Fish HTTP live stream — progressive MP3, no wait-for-full-clip. */
function usesFishLivePreview(v: CatalogVoice, fishConfigured: boolean | null): boolean {
  if (!fishConfigured) return false;
  if (isClonedVoice(v)) return true;
  if (v.model.toLowerCase().includes("fish-audio")) return true;
  return v.tags.some((t) => t.toLowerCase() === "fish-audio");
}

function loadRecent(): RecentVoice[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentVoice[];
    return Array.isArray(parsed) ? parsed.slice(0, 6) : [];
  } catch {
    return [];
  }
}

function saveRecent(entry: RecentVoice) {
  try {
    const prev = loadRecent().filter((r) => r.id !== entry.id);
    const next = [entry, ...prev].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [entry];
  }
}

export default function VoiceSelectionPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-[#D97757]" />
        </div>
      }
    >
      <VoiceSelectionContent />
    </Suspense>
  );
}

function VoiceSelectionContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pdfPath = searchParams.get("pdfPath") || "";
  const pdfName = searchParams.get("pdfName") || "";
  const charCount = Number(searchParams.get("charCount") || "0");

  const [listenVoices, setListenVoices] = useState<CatalogVoice[]>([]);
  const [allVoices, setAllVoices] = useState<CatalogVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [intent, setIntent] = useState<Intent>("listen");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [openRouterConfigured, setOpenRouterConfigured] = useState<boolean | null>(null);
  const [fishCloneConfigured, setFishCloneConfigured] = useState<boolean | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewCooldownUntil, setPreviewCooldownUntil] = useState<number>(0);
  const [cooldownTick, setCooldownTick] = useState(0);
  const [recent, setRecent] = useState<RecentVoice[]>([]);
  const [cloneTitle, setCloneTitle] = useState("");
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloning, setCloning] = useState(false);
  const [deletingCloneId, setDeletingCloneId] = useState<string | null>(null);
  const [voicesReloadToken, setVoicesReloadToken] = useState(0);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewCacheRef = useRef<Map<string, { url: string; mime: string }>>(
    new Map()
  );
  const cloneFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setRecent(loadRecent());
  }, []);

  useEffect(() => {
    if (previewCooldownUntil <= Date.now()) return;
    const id = setInterval(() => setCooldownTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [previewCooldownUntil]);

  useEffect(() => {
    const cache = previewCacheRef.current;
    return () => {
      for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
      cache.clear();
    };
  }, []);

  const previewOnCooldown = Date.now() < previewCooldownUntil;
  void cooldownTick;

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (charCount > 0) params.set("charCount", String(charCount));
    fetch(`/api/tts/voices?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        setAllVoices(data.voices || []);
        setListenVoices(data.listenVoices || data.voices || []);
        setOpenRouterConfigured(
          typeof data.openRouterKeyConfigured === "boolean"
            ? data.openRouterKeyConfigured
            : null
        );
        setFishCloneConfigured(
          typeof data.fishCloneConfigured === "boolean"
            ? data.fishCloneConfigured
            : null
        );
      })
      .catch(() => toast.error("Couldn't load narrators. Please refresh and try again."))
      .finally(() => setLoading(false));
  }, [charCount, voicesReloadToken]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const pool = intent === "listen" ? listenVoices : allVoices;
  const voiceById = useMemo(() => {
    const map = new Map<string, CatalogVoice>();
    for (const v of [...listenVoices, ...allVoices]) map.set(v.id, v);
    return map;
  }, [listenVoices, allVoices]);

  const filteredVoices = useMemo(() => {
    if (!debouncedQuery.trim()) return pool;
    const q = debouncedQuery.toLowerCase();
    return pool.filter(
      (v) =>
        voiceTitle(v).toLowerCase().includes(q) ||
        voiceMeta(v).toLowerCase().includes(q) ||
        (v.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }, [pool, debouncedQuery]);

  const comparePair = recent.slice(0, 2);

  const rememberHeard = (voice: CatalogVoice) => {
    setRecent(
      saveRecent({
        id: voice.id,
        name: voiceTitle(voice),
        meta: voiceMeta(voice),
        at: Date.now(),
      })
    );
  };

  const previewVoice = async (voice: CatalogVoice) => {
    if (previewingId === voice.id && previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
      setPreviewingId(null);
      return;
    }
    if (Date.now() < previewCooldownUntil) {
      const secs = Math.max(1, Math.ceil((previewCooldownUntil - Date.now()) / 1000));
      toast.error(`Please wait ${secs}s before another Live Listen.`);
      return;
    }
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }

    const playUrl = async (url: string) => {
      const audio = new Audio(url);
      audio.onended = () => setPreviewingId(null);
      audio.onerror = () => {
        setPreviewingId(null);
        toast.error("Couldn't play Live Listen. Try again.");
      };
      previewAudioRef.current = audio;
      setPreviewingId(voice.id);
      rememberHeard(voice);
      await audio.play();
    };

    // Fish Live Listen — progressive HTTP stream (chunks as they arrive).
    if (usesFishLivePreview(voice, fishCloneConfigured)) {
      setPreviewLoading(voice.id);
      try {
        const url = `/api/tts/live?catalogVoiceId=${encodeURIComponent(voice.id)}&_=${Date.now()}`;
        const audio = new Audio(url);
        audio.onplaying = () => setPreviewLoading(null);
        audio.onended = () => setPreviewingId(null);
        audio.onerror = () => {
          setPreviewingId(null);
          setPreviewLoading(null);
          toast.error("Couldn't play Live Listen. Check FISH_API_KEY and try again.");
        };
        previewAudioRef.current = audio;
        setPreviewingId(voice.id);
        rememberHeard(voice);
        await audio.play();
      } catch (e: unknown) {
        setPreviewingId(null);
        setPreviewLoading(null);
        toast.error(e instanceof Error ? e.message : "Live Listen failed");
      }
      return;
    }

    const cached = previewCacheRef.current.get(voice.id);
    if (cached) {
      try {
        await playUrl(cached.url);
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Live Listen failed");
      }
      return;
    }

    setPreviewLoading(voice.id);
    try {
      const res = await fetch("/api/tts/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogVoiceId: voice.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 429) setPreviewCooldownUntil(Date.now() + 60_000);
        throw new Error(userFriendlyError(data.error || "Live Listen failed"));
      }
      const headerType = res.headers.get("content-type") || "";
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 256) {
        throw new Error("Live Listen audio was empty. Try again.");
      }
      const mime = sniffPreviewMime(buf, headerType);
      const blob = new Blob([buf], { type: mime });
      const url = URL.createObjectURL(blob);
      previewCacheRef.current.set(voice.id, { url, mime });
      await playUrl(url);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Live Listen failed");
    } finally {
      setPreviewLoading(null);
    }
  };

  const createStockJob = async (
    voice: CatalogVoice,
    jobKind: "stream" | "takehome"
  ) => {
    if (!pdfPath) {
      toast.error("Upload a book first");
      router.push("/");
      return;
    }
    setCreating(`${voice.id}-${jobKind}`);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "stock",
          jobKind,
          pdfStoragePath: pdfPath,
          bookTitle: pdfName || "Untitled",
          catalogVoiceId: voice.id,
          voiceName: voiceTitle(voice),
          charCount: charCount || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create job");

      if (data.duplicate && data.status === "ready") {
        toast.success("Audiobook already ready");
        router.push(`/dashboard/player/${data.jobId}`);
        return;
      }

      if (jobKind === "stream") {
        toast.success(UX.startingChapter);
        router.push(`/dashboard/player/${data.jobId}?mode=stream`);
      } else {
        toast.success(
          data.priceEstimate
            ? `${UX.fullBookStarted.replace("…", "")} · est. €${data.priceEstimate.suggestedPriceEur.toFixed(2)}`
            : UX.fullBookStarted
        );
        // Land on the job page so generation progress is visible; Library is one click away.
        router.push(`/dashboard/player/${data.jobId}`);
      }
    } catch (e: unknown) {
      toast.error(
        userFriendlyError(e instanceof Error ? e.message : "Couldn't start narration")
      );
    } finally {
      setCreating(null);
    }
  };

  const resetFilters = () => {
    setQuery("");
  };

  const submitClone = async () => {
    if (!cloneFile) {
      toast.error("Choose a short audio sample first.");
      return;
    }
    setCloning(true);
    try {
      const clone = await uploadCloneVoice(cloneFile, {
        title: cloneTitle.trim() || "My voice",
      });
      toast.success(`Cloned “${clone.displayName || "voice"}” — ready to narrate.`);
      setCloneTitle("");
      setCloneFile(null);
      if (cloneFileRef.current) cloneFileRef.current.value = "";
      setVoicesReloadToken((n) => n + 1);
    } catch (err) {
      toast.error(
        userFriendlyError(
          err instanceof Error ? err.message : "Couldn't clone that voice."
        )
      );
    } finally {
      setCloning(false);
    }
  };

  const deleteClone = async (voice: CatalogVoice) => {
    if (!isClonedVoice(voice)) return;
    setDeletingCloneId(voice.id);
    try {
      const res = await fetch(`/api/tts/clones/${encodeURIComponent(voice.id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Couldn't delete that clone.");
      }
      toast.success("Cloned voice removed.");
      setVoicesReloadToken((n) => n + 1);
    } catch (err) {
      toast.error(
        userFriendlyError(
          err instanceof Error ? err.message : "Couldn't delete that clone."
        )
      );
    } finally {
      setDeletingCloneId(null);
    }
  };

  const renderVoiceCard = (voice: CatalogVoice, mode: Intent) => {
    const cloned = isClonedVoice(voice);
    const isPlaying = previewingId === voice.id;
    const isLoadingPreview = previewLoading === voice.id;
    return (
      <DrawablyCard
        key={voice.id}
        seed={sketchSeed(`voice-card-${voice.id}`)}
        className={`transition-colors ${
          isPlaying ? "bg-[#D97757]/5" : ""
        }`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <button
            type="button"
            className="flex-1 min-w-0 text-left"
            onClick={() => previewVoice(voice)}
            disabled={
              (!!previewLoading && previewLoading !== voice.id) || previewOnCooldown
            }
          >
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-medium font-serif text-lg">{voiceTitle(voice)}</h3>
              {cloned ? (
                <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                  <Mic className="w-3 h-3" />
                  Cloned
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Fish Audio
                </span>
              )}
              {isPlaying && (
                <span className="text-[10px] uppercase tracking-wider text-[#D97757]">
                  Playing
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{voiceMeta(voice)}</p>
            {mode === "full" && voice.priceEstimate && (
              <p className="text-xs mt-2 text-[#D97757]">
                Est. €{voice.priceEstimate.suggestedPriceEur.toFixed(2)}
                {" · "}
                ~{voice.priceEstimate.estimatedAudioHours}h audio
                {voice.generationEta?.label
                  ? ` · ${voice.generationEta.label} to generate`
                  : null}
              </p>
            )}
            {mode === "full" && !voice.priceEstimate && voice.generationEta?.label && (
              <p className="text-xs mt-2 text-muted-foreground">
                {voice.generationEta.label} to generate
              </p>
            )}
            <p className="text-[10px] text-muted-foreground/70 mt-2 sm:hidden">
              Tap name for {UX.liveListen}
            </p>
          </button>
          <div className="flex flex-wrap gap-2 shrink-0">
            {cloned && (
              <Button
                size="sm"
                variant="ghost"
                disabled={deletingCloneId === voice.id}
                onClick={() => deleteClone(voice)}
                className="gap-1.5 px-2.5 text-muted-foreground"
                title="Delete cloned voice"
              >
                {deletingCloneId === voice.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={
                (!!previewLoading && previewLoading !== voice.id) ||
                previewOnCooldown
              }
              onClick={() => previewVoice(voice)}
              className="gap-1.5 px-2.5"
              title={UX.liveListen}
            >
              {isLoadingPreview ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : isPlaying ? (
                <Square className="w-3.5 h-3.5" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">
                {isPlaying ? UX.liveListenStop : UX.liveListen}
              </span>
            </Button>
            {mode === "listen" ? (
              <DrawablyButton
                variant="solid"
                disabled={!!creating}
                onClick={() => createStockJob(voice, "stream")}
                state={
                  creating === `${voice.id}-stream` ? "loading" : "idle"
                }
                seed={sketchSeed(`voice-stream-${voice.id}`)}
              >
                {creating === `${voice.id}-stream` ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Headphones className="w-3.5 h-3.5" />
                )}
                {UX.startListening}
              </DrawablyButton>
            ) : (
              <DrawablyButton
                variant="solid"
                disabled={!!creating}
                onClick={() => createStockJob(voice, "takehome")}
                state={
                  creating === `${voice.id}-takehome` ? "loading" : "idle"
                }
                seed={sketchSeed(`voice-full-${voice.id}`)}
              >
                {creating === `${voice.id}-takehome` ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                {UX.wholeBookShort}
              </DrawablyButton>
            )}
          </div>
        </div>
      </DrawablyCard>
    );
  };

  return (
    <div className="max-w-3xl mx-auto pt-8 pb-16 px-4">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center space-y-3 mb-8"
      >
        <h1
          className="text-5xl md:text-6xl tracking-tight font-serif"
          style={{ fontWeight: 300 }}
        >
          Choose a narrator
        </h1>
        <p className="text-lg text-muted-foreground font-serif max-w-xl mx-auto">
          Fish Audio only — use the default Narrator or clone your own voice.
        </p>
      </motion.div>

      {pdfName && (
        <div className="flex justify-center mb-6">
          <button
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-sm bg-accent border border-border/50 text-xs text-muted-foreground hover:border-border transition-colors"
            onClick={() => router.push("/")}
          >
            <ArrowLeft className="w-3 h-3" />
            <span className="max-w-[180px] truncate">{pdfName}</span>
          </button>
        </div>
      )}

      <DrawablyTabs
        active={intent === "listen" ? 0 : 1}
        seed={sketchSeed("voice-intent")}
        className="ec-tabs mb-4"
      >
        <button
          type="button"
          role="tab"
          onClick={() => {
            setIntent("listen");
            resetFilters();
          }}
          className="inline-flex items-center gap-2"
        >
          <Headphones className="w-3.5 h-3.5" />
          {UX.tryChapter}
        </button>
        <button
          type="button"
          role="tab"
          onClick={() => {
            setIntent("full");
            resetFilters();
          }}
          className="inline-flex items-center gap-2"
        >
          <Download className="w-3.5 h-3.5" />
          {UX.wholeBook}
        </button>
      </DrawablyTabs>

      <p className="text-xs text-muted-foreground text-center mb-6 leading-relaxed">
        {intent === "listen" ? UX.tryChapterBlurb : UX.wholeBookBlurb}{" "}
        {UX.previewHint}
      </p>

      {fishCloneConfigured && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <DrawablyCard
            seed={sketchSeed("voice-clone")}
            className="space-y-3"
          >
          <div className="flex items-start gap-2">
            <Mic className="w-4 h-4 mt-0.5 text-[#D97757] shrink-0" />
            <div className="min-w-0">
              <p className="font-serif text-base">Clone a voice</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                Upload ~10–60s of clear speech (up to {maxCloneSampleMb()} MB).
                Fish Audio builds a private narrator for Live Listen, Live
                Stream, and whole-book download. Samples go straight to
                storage, not through this page’s request limit.
              </p>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-2">
              <DrawablyInput
                value={cloneTitle}
                onChange={(e) => setCloneTitle(e.target.value)}
                placeholder="Name (e.g. Alex)"
                maxLength={80}
                seed={sketchSeed("voice-clone-name")}
                aria-label="Clone voice name"
              />
              <input
                ref={cloneFileRef}
                type="file"
                accept="audio/wav,audio/mpeg,audio/mp4,audio/mp3,audio/ogg,audio/webm,.wav,.mp3,.m4a,.opus,.ogg,.webm"
                onChange={(e) => setCloneFile(e.target.files?.[0] || null)}
                className="block w-full text-xs text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded-sm file:border-0 file:bg-foreground file:text-background file:text-xs"
              />
            </div>
            <DrawablyButton
              variant="solid"
              disabled={cloning || !cloneFile}
              onClick={submitClone}
              state={cloning ? "loading" : "idle"}
              seed={sketchSeed("voice-clone-submit")}
            >
              {cloning ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Mic className="w-3.5 h-3.5" />
              )}
              {cloning ? "Cloning…" : "Clone voice"}
            </DrawablyButton>
          </div>
          {cloneFile && (
            <p className="text-[11px] text-muted-foreground truncate">
              Sample: {cloneFile.name} ({Math.round(cloneFile.size / 1024)} KB)
            </p>
          )}
          </DrawablyCard>
        </motion.div>
      )}

      {fishCloneConfigured === false && (
        <p className="text-xs text-muted-foreground text-center mb-6">
          Voice cloning is off until <code className="text-[11px]">FISH_API_KEY</code>{" "}
          is set on the server.
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !pdfPath ? (
        <DrawablyCard
          seed={sketchSeed("voice-empty")}
          className="text-center py-10 space-y-4"
        >
          <p className="text-muted-foreground font-serif">
            Upload or paste text to choose a narrator.
          </p>
          <p className="text-xs text-muted-foreground/80 max-w-sm mx-auto">
            Already generating a book? Open Library to watch progress or listen.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <DrawablyButton
              variant="solid"
              onClick={() => router.push("/")}
              seed={sketchSeed("voice-empty-new")}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              New audiobook
            </DrawablyButton>
            <DrawablyButton
              onClick={() => router.push("/dashboard/queue")}
              seed={sketchSeed("voice-empty-library")}
            >
              <Headphones className="w-3.5 h-3.5" />
              Library
            </DrawablyButton>
          </div>
        </DrawablyCard>
      ) : pool.length === 0 ? (
        <DrawablyCard
          seed={sketchSeed("voice-unavailable")}
          className="text-center py-10"
        >
          <p className="text-muted-foreground">Narrators unavailable right now.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            {openRouterConfigured === false
              ? "Please try again later — our voice catalog is temporarily offline."
              : "Please refresh the page or try again in a few minutes."}
          </p>
        </DrawablyCard>
      ) : (
        <>
          <AnimatePresence>
            {recent.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mb-6"
              >
                <DrawablyCard seed={sketchSeed("voice-recent")}>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-serif">
                    {UX.recentlyHeard}
                  </p>
                  {comparePair.length === 2 && (
                    <span className="text-[10px] text-[#D97757] uppercase tracking-wider">
                      {UX.compare}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {recent.slice(0, 4).map((r) => {
                    const voice = voiceById.get(r.id);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        disabled={!voice || previewOnCooldown}
                        onClick={() => voice && previewVoice(voice)}
                        className={`inline-flex items-center gap-2 px-3 py-2 rounded-sm border text-left transition-colors ${
                          previewingId === r.id
                            ? "border-[#D97757]/50 bg-[#D97757]/10"
                            : "border-border/50 hover:border-foreground/30"
                        }`}
                      >
                        {previewLoading === r.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-[#D97757]" />
                        ) : previewingId === r.id ? (
                          <Square className="w-3.5 h-3.5 text-[#D97757]" />
                        ) : (
                          <RotateCcw className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                        <span className="min-w-0">
                          <span className="block text-sm font-serif truncate max-w-[140px]">
                            {r.name}
                          </span>
                          <span className="block text-[10px] text-muted-foreground truncate max-w-[140px]">
                            {r.meta}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                </DrawablyCard>
              </motion.div>
            )}
          </AnimatePresence>

          {pool.length > 3 && (
            <div className="mb-6">
              <DrawablyInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search narrators…"
                seed={sketchSeed("voice-search")}
                aria-label="Search narrators"
              />
            </div>
          )}

          <motion.div
            key={intent}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {filteredVoices.length === 0 ? (
              <p className="text-center text-muted-foreground py-12">
                {debouncedQuery.trim()
                  ? `No narrators match “${debouncedQuery}”.`
                  : "No Fish narrators available right now."}
              </p>
            ) : (
              <div className="grid gap-3">
                {filteredVoices.map((voice) => renderVoiceCard(voice, intent))}
              </div>
            )}
          </motion.div>
        </>
      )}

      <div className="flex items-center justify-center gap-2 mt-10">
        <span className="w-1.5 h-1.5 rounded-full bg-[#7a8f7e]" />
        <span className="w-1.5 h-1.5 rounded-full bg-[#D97757]" />
        <span className="w-1.5 h-1.5 rounded-full bg-[#2a2a2a]" />
      </div>
    </div>
  );
}
