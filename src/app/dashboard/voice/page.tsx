"use client";

import { Button } from "@/components/ui/button";
import {
  Loader2,
  ArrowLeft,
  Headphones,
  Play,
  Square,
  Mic,
  Trash2,
} from "lucide-react";
import { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { userFriendlyError } from "@/lib/errors-ui";
import { uploadCloneVoice } from "@/lib/upload-client";
import { toast } from "sonner";
import { motion } from "motion/react";
import { PREVIEW_TEXT, sniffPreviewMime } from "@/lib/tts/preview-text";
import {
  cancelBrowserSpeech,
  speakPreviewForStockVoice,
} from "@/lib/tts/browser-speech";
import { isEdgeStockVoice } from "@/lib/tts/standard-voice";
import { isCuratedFishStockVoice } from "@/lib/tts/curated-fish-stock";
import { UX, VOICE_PATH } from "@/lib/ux-copy";
import {
  isUserCloneVoice,
  parseVoicePath,
  voicesForPath,
  withVoicePathParam,
  type VoicePath,
} from "@/lib/voice-path";
import {
  DEFAULT_DELIVERY_PREF,
  NarrationDeliveryControls,
  deliveryPrefToTtsOptions,
  loadDeliveryPref,
  saveDeliveryPref,
  type DeliveryPref,
} from "@/app/dashboard/narration-delivery-controls";
import {
  CLONE_SAMPLE_QUALITY_COPY,
  type CloneSampleQualityReport,
} from "@/lib/tts/clone-sample-quality";
import { analyzeCloneSampleFile } from "@/lib/tts/clone-sample-quality-browser";

type AccentId = "american" | "british" | "australian" | "irish" | "other";
type VibeId = "calm" | "warm" | "upbeat" | "smooth" | "dramatic" | "clear";

interface CatalogVoice {
  id: string;
  provider?: string;
  providerVoiceId?: string;
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

function voiceTitle(v: CatalogVoice): string {
  return v.friendlyName || v.displayName;
}

function isClonedVoice(v: CatalogVoice): boolean {
  return isUserCloneVoice(v);
}

/** Fish HTTP live stream — progressive MP3, no wait-for-full-clip. */
function usesFishLivePreview(v: CatalogVoice, fishConfigured: boolean | null): boolean {
  if (!fishConfigured) return false;
  if (isCuratedFishStockVoice(v)) return true;
  if (isClonedVoice(v)) return true;
  if (v.model.toLowerCase().includes("fish-audio")) return true;
  return v.tags.some((t) => t.toLowerCase() === "fish-audio");
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

  const [allVoices, setAllVoices] = useState<CatalogVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<string | null>(null);
  const [fishCloneConfigured, setFishCloneConfigured] = useState<boolean | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewCooldownUntil, setPreviewCooldownUntil] = useState<number>(0);
  const [cooldownTick, setCooldownTick] = useState(0);
  const [deliveryPref, setDeliveryPref] = useState<DeliveryPref>(
    DEFAULT_DELIVERY_PREF
  );
  const [cloneTitle, setCloneTitle] = useState("");
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneQuality, setCloneQuality] = useState<CloneSampleQualityReport | null>(
    null
  );
  const [cloneQualityChecking, setCloneQualityChecking] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [deletingCloneId, setDeletingCloneId] = useState<string | null>(null);
  const [voicesReloadToken, setVoicesReloadToken] = useState(0);
  const [showDelivery, setShowDelivery] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const browserSpeechActiveRef = useRef(false);
  const previewCacheRef = useRef<Map<string, { url: string; mime: string }>>(
    new Map()
  );
  const cloneFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDeliveryPref(loadDeliveryPref());
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
        setFishCloneConfigured(
          typeof data.fishCloneConfigured === "boolean"
            ? data.fishCloneConfigured
            : null
        );
      })
      .catch(() => toast.error("Couldn't load narrators. Please refresh and try again."))
      .finally(() => setLoading(false));
  }, [charCount, voicesReloadToken]);

  const voicePath = parseVoicePath(searchParams.get("path"));
  const pathVoices = useMemo(
    () => (voicePath ? voicesForPath(allVoices, voicePath) : []),
    [allVoices, voicePath]
  );

  const setVoicePath = (path: VoicePath | null) => {
    const q = withVoicePathParam(searchParams.toString(), path);
    const qs = q.toString();
    router.push(qs ? `/dashboard/voice?${qs}` : "/dashboard/voice");
  };

  const stopPreviewPlayback = () => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }
    if (browserSpeechActiveRef.current) {
      cancelBrowserSpeech();
      browserSpeechActiveRef.current = false;
    }
    setPreviewingId(null);
    setPreviewLoading(null);
  };

  const previewVoice = async (voice: CatalogVoice) => {
    if (previewingId === voice.id && (previewAudioRef.current || browserSpeechActiveRef.current)) {
      stopPreviewPlayback();
      return;
    }
    if (Date.now() < previewCooldownUntil) {
      const secs = Math.max(1, Math.ceil((previewCooldownUntil - Date.now()) / 1000));
      toast.error(`Please wait ${secs}s before another sample.`);
      return;
    }
    stopPreviewPlayback();

    const playUrl = async (url: string) => {
      const audio = new Audio(url);
      audio.onended = () => setPreviewingId(null);
      audio.onerror = () => {
        setPreviewingId(null);
        toast.error("Couldn't play the sample. Try again.");
      };
      previewAudioRef.current = audio;
      setPreviewingId(voice.id);
      await audio.play();
    };

    // Edge short sample — matching neural only (never a random system voice).
    if (isEdgeStockVoice(voice)) {
      setPreviewLoading(voice.id);
      try {
        const result = await speakPreviewForStockVoice(PREVIEW_TEXT, voice, {
          onEnd: () => {
            browserSpeechActiveRef.current = false;
            setPreviewingId(null);
          },
          onError: () => {
            browserSpeechActiveRef.current = false;
            setPreviewingId(null);
          },
        });
        if (result === "played") {
          browserSpeechActiveRef.current = true;
          setPreviewingId(voice.id);
          setPreviewLoading(null);
          return;
        }
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Couldn't play the sample");
        setPreviewLoading(null);
        return;
      }
      // Matching neural isn't in this browser — server Edge TTS, not a system voice.
    }

    // Fish short sample — progressive HTTP stream (chunks as they arrive).
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
          toast.error("Couldn't play the sample. Try again.");
        };
        previewAudioRef.current = audio;
        setPreviewingId(voice.id);
        await audio.play();
      } catch (e: unknown) {
        setPreviewingId(null);
        setPreviewLoading(null);
        toast.error(e instanceof Error ? e.message : "Couldn't play the sample");
      }
      return;
    }

    const cached = previewCacheRef.current.get(voice.id);
    if (cached) {
      try {
        await playUrl(cached.url);
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Couldn't play the sample");
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
        throw new Error(userFriendlyError(data.error || "Couldn't play the sample"));
      }
      const headerType = res.headers.get("content-type") || "";
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 256) {
        throw new Error("Sample audio was empty. Try again.");
      }
      const mime = sniffPreviewMime(buf, headerType);
      const blob = new Blob([buf], { type: mime });
      const url = URL.createObjectURL(blob);
      previewCacheRef.current.set(voice.id, { url, mime });
      await playUrl(url);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Couldn't play the sample");
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
          ...(jobKind === "takehome"
            ? { ttsOptions: deliveryPrefToTtsOptions(deliveryPref) }
            : {}),
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

  const onCloneFileChange = async (file: File | null) => {
    setCloneFile(file);
    setCloneQuality(null);
    if (!file) {
      setCloneQualityChecking(false);
      return;
    }
    setCloneQualityChecking(true);
    try {
      const report = await analyzeCloneSampleFile(file);
      setCloneQuality(report);
      if (report?.verdict === "fail") {
        toast.error(report.headline);
      }
    } finally {
      setCloneQualityChecking(false);
    }
  };

  const submitClone = async () => {
    if (!cloneFile) {
      toast.error("Choose a short audio sample first.");
      return;
    }
    if (cloneQuality?.verdict === "fail") {
      toast.error(cloneQuality.headline);
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
      setCloneQuality(null);
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

  const renderVoiceCard = (voice: CatalogVoice) => {
    const cloned = isClonedVoice(voice);
    const isPlaying = previewingId === voice.id;
    const isLoadingPreview = previewLoading === voice.id;
    const priceLabel = voice.priceEstimate
      ? `Est. €${voice.priceEstimate.suggestedPriceEur.toFixed(2)}${
          voice.generationEta?.label ? ` · ${voice.generationEta.label}` : ""
        }`
      : voice.generationEta?.label || null;
    return (
      <motion.div
        key={voice.id}
        layout
        className={`border rounded-sm p-4 transition-colors ${
          isPlaying
            ? "border-[#D97757]/50 bg-[#D97757]/5"
            : "border-border hover:border-foreground/25"
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
              {isPlaying && (
                <span className="text-[10px] uppercase tracking-wider text-[#D97757]">
                  Playing
                </span>
              )}
            </div>
            {priceLabel && (
              <p className="text-xs mt-2 text-muted-foreground">{priceLabel}</p>
            )}
          </button>
          <div className="flex flex-col items-stretch sm:items-end gap-1.5 shrink-0">
            <div className="flex flex-wrap gap-2 sm:justify-end">
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
                className="px-2.5 text-muted-foreground"
                title="Sample"
              >
                {isLoadingPreview ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : isPlaying ? (
                  <Square className="w-3.5 h-3.5" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
              </Button>
              <Button
                size="sm"
                disabled={!!creating}
                onClick={() => createStockJob(voice, "stream")}
                className="gap-1.5 bg-[#D97757] text-white hover:bg-[#D97757]/90"
              >
                {creating === `${voice.id}-stream` ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Headphones className="w-3.5 h-3.5" />
                )}
                {UX.preview}
              </Button>
            </div>
            <button
              type="button"
              disabled={!!creating}
              onClick={() => createStockJob(voice, "takehome")}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 text-left sm:text-right px-1 py-0.5"
            >
              {creating === `${voice.id}-takehome` ? "Starting…" : UX.makeAudiobook}
            </button>
          </div>
        </div>
      </motion.div>
    );
  };

  const heading =
    voicePath === "standard"
      ? VOICE_PATH.standardTitle
      : voicePath === "clone"
        ? VOICE_PATH.cloneTitle
        : null;

  const needsBook = voicePath === "standard" && !pdfPath;
  const stockUnavailable =
    voicePath === "standard" && !loading && pdfPath && pathVoices.length === 0;

  return (
    <div className="max-w-3xl mx-auto pt-8 pb-16 px-4">
      {heading ? (
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-8"
        >
          <h1
            className="text-5xl md:text-6xl tracking-tight font-serif"
            style={{ fontWeight: 300 }}
          >
            {heading}
          </h1>
        </motion.div>
      ) : null}

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

      {!voicePath ? (
        <div className="grid gap-3 sm:grid-cols-2 mb-4">
          <button
            type="button"
            onClick={() => setVoicePath("standard")}
            className="text-center border border-border/60 rounded-sm px-5 py-10 hover:border-foreground/25 transition-colors"
          >
            <p className="font-serif text-xl">{VOICE_PATH.standardTitle}</p>
          </button>
          <button
            type="button"
            onClick={() => setVoicePath("clone")}
            className="text-center border border-border/60 rounded-sm px-5 py-10 hover:border-foreground/25 transition-colors"
          >
            <p className="font-serif text-xl">{VOICE_PATH.cloneTitle}</p>
          </button>
        </div>
      ) : (
        <>
          <div className="flex justify-center mb-6">
            <button
              type="button"
              onClick={() => setVoicePath(null)}
              className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-3 h-3" />
              {VOICE_PATH.backToPaths}
            </button>
          </div>

          {voicePath === "clone" && fishCloneConfigured && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-8 p-4 rounded-sm border border-border/60 space-y-3"
            >
              <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="space-y-2">
                  <input
                    value={cloneTitle}
                    onChange={(e) => setCloneTitle(e.target.value)}
                    placeholder="Name (e.g. Alex)"
                    maxLength={80}
                    className="w-full h-10 px-3 rounded-sm border border-border bg-background text-sm"
                  />
                  <input
                    ref={cloneFileRef}
                    type="file"
                    accept="audio/wav,audio/mpeg,audio/mp4,audio/mp3,audio/ogg,audio/webm,.wav,.mp3,.m4a,.opus,.ogg,.webm"
                    onChange={(e) =>
                      void onCloneFileChange(e.target.files?.[0] || null)
                    }
                    className="block w-full text-xs text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded-sm file:border-0 file:bg-foreground file:text-background file:text-xs"
                  />
                </div>
                <Button
                  disabled={
                    cloning ||
                    !cloneFile ||
                    cloneQualityChecking ||
                    cloneQuality?.verdict === "fail"
                  }
                  onClick={submitClone}
                  className="gap-1.5 h-10"
                >
                  {cloning ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Mic className="w-3.5 h-3.5" />
                  )}
                  {cloning ? "Cloning…" : "Clone voice"}
                </Button>
              </div>
              {cloneFile && (
                <p className="text-[11px] text-muted-foreground truncate">
                  Sample: {cloneFile.name} ({Math.round(cloneFile.size / 1024)} KB)
                </p>
              )}
              {cloneQualityChecking && (
                <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Checking sample…
                </p>
              )}
              {cloneQuality?.verdict === "fail" && (
                <div className="rounded-sm border border-red-500/30 bg-red-500/5 px-3 py-2 space-y-1">
                  <p className="text-sm font-medium text-red-700 dark:text-red-400">
                    {cloneQuality.headline}
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {cloneQuality.primary_message}
                  </p>
                  {cloneQuality.fails.some(
                    (f) =>
                      f.code === "too_reverberant" || f.code === "echo_in_speech"
                  ) ? (
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {CLONE_SAMPLE_QUALITY_COPY.reverbDetail}
                    </p>
                  ) : (
                    cloneQuality.fails[0]?.detail && (
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {cloneQuality.fails[0].detail}
                      </p>
                    )
                  )}
                </div>
              )}
              {cloneQuality?.verdict === "warn" && (
                <div className="rounded-sm border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-1">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                    {cloneQuality.headline}
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {cloneQuality.primary_message}
                  </p>
                </div>
              )}
            </motion.div>
          )}

          {voicePath === "clone" && fishCloneConfigured === false && (
            <p className="text-xs text-muted-foreground text-center mb-6">
              {VOICE_PATH.cloneUnavailable}
            </p>
          )}

          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : needsBook ? (
            <div className="text-center py-16 border border-dashed border-border/50 rounded-sm space-y-4">
              <p className="text-muted-foreground font-serif">
                Upload or paste text first.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button onClick={() => router.push("/")} className="gap-2">
                  <ArrowLeft className="w-3.5 h-3.5" />
                  New audiobook
                </Button>
                <Button
                  variant="outline"
                  onClick={() => router.push("/dashboard/queue")}
                  className="gap-2"
                >
                  <Headphones className="w-3.5 h-3.5" />
                  Library
                </Button>
              </div>
            </div>
          ) : stockUnavailable ? (
            <div className="text-center py-16 border border-dashed border-border/50 rounded-sm">
              <p className="text-muted-foreground">Voices unavailable right now.</p>
            </div>
          ) : pathVoices.length === 0 ? (
            voicePath === "clone" && fishCloneConfigured ? (
              <p className="text-center text-muted-foreground py-8 font-serif">
                {VOICE_PATH.noClones}
              </p>
            ) : null
          ) : (
            <motion.div
              key={voicePath}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="grid gap-3">
                {pathVoices.map((voice) => renderVoiceCard(voice))}
              </div>
              <div className="mt-8">
                <button
                  type="button"
                  onClick={() => setShowDelivery((open) => !open)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {UX.narrationDelivery}
                </button>
                {showDelivery && (
                  <div className="mt-3">
                    <NarrationDeliveryControls
                      value={deliveryPref}
                      onChange={(next) => {
                        setDeliveryPref(next);
                        saveDeliveryPref(next);
                      }}
                    />
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </>
      )}
    </div>
  );
}
