"use client";

import {
  Loader2,
  ArrowLeft,
  Play,
  Square,
  Trash2,
  Check,
  ChevronRight,
  X,
} from "lucide-react";
import { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { userFriendlyError } from "@/lib/errors-ui";
import {
  updateCloneAccent,
  uploadCloneVoice,
  uploadIdFromStoragePath,
  waitForUploadExtract,
  type UploadChapter,
  type UploadedCloneVoice,
} from "@/lib/upload-client";
import {
  CLONE_ACCENT_LABELS,
  CLONE_ACCENTS,
  DEFAULT_CLONE_ACCENT,
  isCloneAccent,
  type CloneAccent,
} from "@/lib/tts/clone-accent";
import { toast } from "sonner";
import { motion } from "motion/react";
import { PREVIEW_TEXT, sniffPreviewMime } from "@/lib/tts/preview-text";
import {
  expressiveChoiceEnabled,
  showExpressiveChoice,
  stockDeliveryLabel,
  type ExpressiveOffer,
  type StockDeliveryMode,
} from "@/lib/tts/stock-delivery";
import {
  narratorMarksVoice,
  withNarratorRecommendation,
  type NarratorRecommendation,
} from "@/lib/tts/narrator-suggestion";
import {
  cancelBrowserSpeech,
  speakPreviewForStockVoice,
} from "@/lib/tts/browser-speech";
import { isEdgeStockVoice } from "@/lib/tts/standard-voice";
import { isCuratedFishStockVoice } from "@/lib/tts/curated-fish-stock";
import { WaitMark } from "@/components/wait-mark";
import { UX, VOICE_PATH, WAIT } from "@/lib/ux-copy";
import {
  isUserCloneVoice,
  parseVoicePath,
  voicesForPath,
  withVoicePathParam,
  type VoicePath,
} from "@/lib/voice-path";
import { resolveVoiceContinue } from "@/lib/voice-continue";
import {
  DEFAULT_DELIVERY_PREF,
  deliveryPrefToTtsOptions,
  loadDeliveryPref,
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
  expressive?: ExpressiveOffer | null;
}

function voiceTitle(v: CatalogVoice): string {
  return v.friendlyName || v.displayName;
}

function isClonedVoice(v: CatalogVoice): boolean {
  return isUserCloneVoice(v);
}

function catalogVoiceFromClone(
  clone: UploadedCloneVoice,
  accent: CloneAccent
): CatalogVoice {
  const name = clone.displayName || "My voice";
  return {
    id: clone.catalogVoiceId,
    provider: "fish",
    displayName: name,
    friendlyName: name,
    accent,
    language: "en",
    locale: "en",
    gender: "",
    style: "",
    tags: ["cloned"],
    model: "",
    latencyClass: "",
  };
}

function cloneAccentOf(voice: CatalogVoice): CloneAccent {
  return isCloneAccent(voice.accent) ? voice.accent : DEFAULT_CLONE_ACCENT;
}

function CloneAccentPicker({
  value,
  onChange,
  disabled,
  label = "Accent",
}: {
  value: CloneAccent;
  onChange: (accent: CloneAccent) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1"
      role="radiogroup"
      aria-label={label}
    >
      {CLONE_ACCENTS.map((accent) => {
        const selected = value === accent;
        return (
          <button
            key={accent}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(accent)}
            className={`text-xs transition-colors disabled:opacity-30 ${
              selected
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {CLONE_ACCENT_LABELS[accent]}
          </button>
        );
      })}
    </div>
  );
}

/** Fish HTTP chunked preview — progressive MP3, no wait-for-full-clip. */
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
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
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
  const uploadId =
    searchParams.get("uploadId") || uploadIdFromStoragePath(pdfPath) || "";

  const [allVoices, setAllVoices] = useState<CatalogVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(null);
  const [deliveryById, setDeliveryById] = useState<
    Record<string, StockDeliveryMode>
  >({});
  const [compareSide, setCompareSide] = useState<
    "standard" | "expressive" | null
  >(null);
  const [linePreview, setLinePreview] = useState<StockDeliveryMode | null>(
    null
  );
  const [pinnedVoiceId, setPinnedVoiceId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [fishCloneConfigured, setFishCloneConfigured] = useState<boolean | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewCooldownUntil, setPreviewCooldownUntil] = useState<number>(0);
  const [cooldownTick, setCooldownTick] = useState(0);
  const [deliveryPref, setDeliveryPref] = useState<DeliveryPref>(
    DEFAULT_DELIVERY_PREF
  );
  const [cloneTitle, setCloneTitle] = useState("");
  const [cloneAccent, setCloneAccent] = useState<CloneAccent>(DEFAULT_CLONE_ACCENT);
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneQuality, setCloneQuality] = useState<CloneSampleQualityReport | null>(
    null
  );
  const [cloneQualityChecking, setCloneQualityChecking] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [deletingCloneId, setDeletingCloneId] = useState<string | null>(null);
  const [savingAccentId, setSavingAccentId] = useState<string | null>(null);
  const [voicesReloadToken, setVoicesReloadToken] = useState(0);
  const [extractStatus, setExtractStatus] = useState<
    "ready" | "preparing" | "failed"
  >(charCount > 0 || !uploadId ? "ready" : "preparing");
  const [extractChars, setExtractChars] = useState(charCount);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [chapters, setChapters] = useState<UploadChapter[]>([]);
  const [narrator, setNarrator] = useState<NarratorRecommendation | null>(null);
  const [narratorSettled, setNarratorSettled] = useState(!uploadId);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const browserSpeechActiveRef = useRef(false);
  const playbackGenRef = useRef(0);
  const playbackDoneRef = useRef<((ok: boolean) => void) | null>(null);
  const previewCacheRef = useRef<Map<string, { url: string; mime: string }>>(
    new Map()
  );
  const cloneFileRef = useRef<HTMLInputElement | null>(null);
  const continueLockRef = useRef(false);
  const narratorTouchedRef = useRef(false);

  useEffect(() => {
    setDeliveryPref(loadDeliveryPref());
  }, []);

  useEffect(() => {
    if (!uploadId) return;
    const ac = new AbortController();
    if (charCount > 0) {
      void fetch(`/api/pdf/upload/${uploadId}`, { signal: ac.signal })
        .then(async (res) => {
          if (!res.ok) return;
          const data = (await res.json()) as { chapters?: UploadChapter[] };
          if (Array.isArray(data.chapters)) setChapters(data.chapters);
        })
        .catch(() => {});
      return () => ac.abort();
    }
    setExtractStatus("preparing");
    setExtractError(null);
    void waitForUploadExtract(uploadId, { signal: ac.signal })
      .then((data) => {
        setExtractChars(data.charCount ?? 0);
        setExtractStatus("ready");
        setChapters(Array.isArray(data.chapters) ? data.chapters : []);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setExtractStatus("failed");
        setExtractError(
          err instanceof Error ? err.message : "Could not read this document."
        );
      });
    return () => ac.abort();
  }, [uploadId, charCount]);

  useEffect(() => {
    if (!uploadId || extractStatus === "failed") {
      setNarratorSettled(true);
      return;
    }
    if (extractStatus !== "ready") return;
    let cancelled = false;
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 2_500);
    void fetch(`/api/pdf/upload/${uploadId}/narrator`, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          narrator?: NarratorRecommendation | null;
        };
        if (data.narrator?.catalogVoiceId) setNarrator(data.narrator);
      })
      .catch(() => {})
      .finally(() => {
        window.clearTimeout(timer);
        if (!cancelled) setNarratorSettled(true);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [uploadId, extractStatus]);

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
    fetch("/api/tts/voices")
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
  }, [voicesReloadToken]);

  useEffect(() => {
    setDeliveryById((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const voice of allVoices) {
        if (
          next[voice.id] === "expressive" &&
          !expressiveChoiceEnabled(voice.expressive)
        ) {
          delete next[voice.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [allVoices]);

  const voicePath = parseVoicePath(searchParams.get("path"));
  const pathVoices = useMemo(
    () => (voicePath ? voicesForPath(allVoices, voicePath) : []),
    [allVoices, voicePath]
  );
  const selectedVoice =
    pathVoices.find((voice) => voice.id === selectedVoiceId) ?? null;
  const pendingSample =
    voicePath === "clone" && fishCloneConfigured === true && cloneFile != null;

  useEffect(() => {
    if (pinnedVoiceId) {
      if (pathVoices.some((voice) => voice.id === pinnedVoiceId)) {
        if (selectedVoiceId !== pinnedVoiceId) setSelectedVoiceId(pinnedVoiceId);
        return;
      }
      // Catalog reload hasn't returned the new clone yet. Don't snap back
      // to whichever saved voice happens to be first.
      if (loading) return;
      setPinnedVoiceId(null);
      return;
    }
    if (narratorTouchedRef.current) {
      if (pathVoices.some((voice) => voice.id === selectedVoiceId)) return;
      setSelectedVoiceId(pathVoices[0]?.id ?? null);
      return;
    }
    if (voicePath === "standard" && narrator) {
      const suggested = pathVoices.find(
        (voice) => voice.id === narrator.catalogVoiceId
      );
      if (suggested) {
        if (selectedVoiceId !== suggested.id) setSelectedVoiceId(suggested.id);
        return;
      }
    }
    if (pathVoices.some((voice) => voice.id === selectedVoiceId)) return;
    setSelectedVoiceId(pathVoices[0]?.id ?? null);
  }, [pathVoices, selectedVoiceId, pinnedVoiceId, loading, voicePath, narrator]);

  useEffect(() => {
    if (voicePath !== "standard" || !narrator || narratorTouchedRef.current) {
      return;
    }
    const voice = pathVoices.find((item) => item.id === narrator.catalogVoiceId);
    if (!voice) return;
    const mode: StockDeliveryMode =
      narrator.delivery === "expressive" &&
      expressiveChoiceEnabled(voice.expressive)
        ? "expressive"
        : "standard";
    setDeliveryById((prev) =>
      prev[voice.id] === mode ? prev : { ...prev, [voice.id]: mode }
    );
  }, [voicePath, narrator, pathVoices]);

  const setVoicePath = (path: VoicePath | null) => {
    setPinnedVoiceId(null);
    const q = withVoicePathParam(searchParams.toString(), path);
    const qs = q.toString();
    router.push(qs ? `/dashboard/voice?${qs}` : "/dashboard/voice");
  };

  const clearPendingSample = () => {
    setCloneFile(null);
    setCloneQuality(null);
    setCloneQualityChecking(false);
    if (cloneFileRef.current) cloneFileRef.current.value = "";
  };

  const selectVoice = (id: string, opts?: { dismissSample?: boolean }) => {
    narratorTouchedRef.current = true;
    setPinnedVoiceId(null);
    setSelectedVoiceId(id);
    if (opts?.dismissSample) clearPendingSample();
  };

  const deliveryFor = (voiceId: string): StockDeliveryMode =>
    deliveryById[voiceId] ?? "standard";

  const stopPreviewPlayback = () => {
    playbackGenRef.current += 1;
    playbackDoneRef.current?.(false);
    playbackDoneRef.current = null;
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
    setCompareSide(null);
    setLinePreview(null);
  };

  const loadServerPreview = async (
    voice: CatalogVoice,
    delivery: StockDeliveryMode,
    sample: "preview" | "compare"
  ): Promise<string> => {
    const key = `${voice.id}:${delivery}:${sample}`;
    const cached = previewCacheRef.current.get(key);
    if (cached) return cached.url;
    const res = await fetch("/api/tts/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        catalogVoiceId: voice.id,
        delivery,
        sample,
      }),
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
    const url = URL.createObjectURL(new Blob([buf], { type: mime }));
    previewCacheRef.current.set(key, { url, mime });
    return url;
  };

  const playUrlAndWait = (url: string, gen: number): Promise<boolean> => {
    if (gen !== playbackGenRef.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (playbackDoneRef.current === finish) playbackDoneRef.current = null;
        resolve(ok);
      };
      playbackDoneRef.current = finish;
      audio.onplaying = () => setPreviewLoading(null);
      audio.onended = () => finish(gen === playbackGenRef.current);
      audio.onerror = () => finish(false);
      void audio.play().catch(() => finish(false));
    });
  };

  const chooseDelivery = (voice: CatalogVoice, mode: StockDeliveryMode) => {
    if (mode === "expressive" && !expressiveChoiceEnabled(voice.expressive)) {
      return;
    }
    setDeliveryById((prev) => ({ ...prev, [voice.id]: mode }));
    selectVoice(voice.id, { dismissSample: true });
  };

  const playBoth = async (voice: CatalogVoice) => {
    if (!expressiveChoiceEnabled(voice.expressive)) return;
    narratorTouchedRef.current = true;
    // A single-line preview is already this card. Play both still starts,
    // after that clip stops. A second tap during the A/B sequence stops it.
    if (previewingId === voice.id && compareSide) {
      stopPreviewPlayback();
      return;
    }
    stopPreviewPlayback();
    const gen = playbackGenRef.current;
    setPreviewingId(voice.id);
    setPreviewLoading(voice.id);
    try {
      setCompareSide("standard");
      const standardUrl = await loadServerPreview(voice, "standard", "compare");
      if (playbackGenRef.current !== gen) return;
      const standardOk = await playUrlAndWait(standardUrl, gen);
      if (playbackGenRef.current !== gen) return;
      if (!standardOk) {
        toast.error("Couldn't play the Standard sample. Try again.");
        return;
      }
      setPreviewLoading(voice.id);
      setCompareSide("expressive");
      const expressiveUrl = await loadServerPreview(voice, "expressive", "compare");
      if (playbackGenRef.current !== gen) return;
      const expressiveOk = await playUrlAndWait(expressiveUrl, gen);
      if (!expressiveOk && playbackGenRef.current === gen) {
        toast.error("Couldn't play the Expressive sample. Try again.");
      }
    } catch (e: unknown) {
      if (playbackGenRef.current === gen) {
        toast.error(e instanceof Error ? e.message : "Couldn't play the sample");
      }
    } finally {
      if (playbackGenRef.current === gen) {
        setPreviewingId(null);
        setPreviewLoading(null);
        setCompareSide(null);
      }
    }
  };

  const previewVoice = async (voice: CatalogVoice, mode: StockDeliveryMode) => {
    if (mode === "expressive" && !expressiveChoiceEnabled(voice.expressive)) {
      toast.error(UX.expressiveUnavailable);
      return;
    }
    const activeSide = compareSide ?? linePreview;
    if (
      previewingId === voice.id &&
      activeSide === mode &&
      (previewAudioRef.current || browserSpeechActiveRef.current || previewLoading === voice.id)
    ) {
      stopPreviewPlayback();
      return;
    }
    if (Date.now() < previewCooldownUntil) {
      const secs = Math.max(1, Math.ceil((previewCooldownUntil - Date.now()) / 1000));
      toast.error(`Please wait ${secs}s before another sample.`);
      return;
    }
    stopPreviewPlayback();
    if (mode === "expressive") {
      chooseDelivery(voice, "expressive");
    } else {
      chooseDelivery(voice, "standard");
    }
    setLinePreview(mode);
    setPreviewingId(voice.id);

    const playUrl = async (url: string) => {
      const audio = new Audio(url);
      audio.onended = () => {
        setPreviewingId(null);
        setLinePreview(null);
      };
      audio.onerror = () => {
        setPreviewingId(null);
        setLinePreview(null);
        toast.error("Couldn't play the sample. Try again.");
      };
      previewAudioRef.current = audio;
      setPreviewingId(voice.id);
      await audio.play();
    };

    if (mode === "expressive") {
      setPreviewLoading(voice.id);
      try {
        // Compare sample, not the plain one-liner. Fish keeps cue tags;
        // the short preview line sounds like Edge Andrew.
        const url = await loadServerPreview(voice, "expressive", "compare");
        await playUrl(url);
      } catch (e: unknown) {
        setPreviewingId(null);
        setLinePreview(null);
        toast.error(e instanceof Error ? e.message : "Couldn't play the sample");
      } finally {
        setPreviewLoading(null);
      }
      return;
    }

    // Edge short sample — matching neural only (never a random system voice).
    if (isEdgeStockVoice(voice)) {
      setPreviewLoading(voice.id);
      try {
        const result = await speakPreviewForStockVoice(PREVIEW_TEXT, voice, {
          onEnd: () => {
            browserSpeechActiveRef.current = false;
            setPreviewingId(null);
            setLinePreview(null);
          },
          onError: () => {
            browserSpeechActiveRef.current = false;
            setPreviewingId(null);
            setLinePreview(null);
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
        setPreviewingId(null);
        setLinePreview(null);
        setPreviewLoading(null);
        return;
      }
      // Matching neural isn't in this browser — server Edge TTS, not a system voice.
    }

    // Fish short sample — progressive HTTP stream (chunks as they arrive).
    if (usesFishLivePreview(voice, fishCloneConfigured)) {
      setPreviewLoading(voice.id);
      try {
        const deliveryOpts = deliveryPrefToTtsOptions(deliveryPref);
        const liveParams = new URLSearchParams({
          catalogVoiceId: voice.id,
          _: String(Date.now()),
        });
        if (deliveryOpts.pauseStyle !== "auto") {
          liveParams.set("pauseStyle", deliveryOpts.pauseStyle);
        }
        if (deliveryOpts.normalizeTitles !== "auto") {
          liveParams.set(
            "normalizeTitles",
            deliveryOpts.normalizeTitles ? "true" : "false"
          );
        }
        if (deliveryOpts.deliveryPrefix !== "auto") {
          liveParams.set(
            "deliveryPrefix",
            deliveryOpts.deliveryPrefix ? "true" : "false"
          );
        }
        const url = `/api/tts/live?${liveParams.toString()}`;
        const audio = new Audio(url);
        audio.onplaying = () => setPreviewLoading(null);
        audio.onended = () => {
          setPreviewingId(null);
          setLinePreview(null);
        };
        audio.onerror = () => {
          setPreviewingId(null);
          setLinePreview(null);
          setPreviewLoading(null);
          toast.error("Couldn't play the sample. Try again.");
        };
        previewAudioRef.current = audio;
        setPreviewingId(voice.id);
        await audio.play();
      } catch (e: unknown) {
        setPreviewingId(null);
        setLinePreview(null);
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
        setPreviewingId(null);
        setLinePreview(null);
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
      setPreviewingId(null);
      setLinePreview(null);
      toast.error(e instanceof Error ? e.message : "Couldn't play the sample");
    } finally {
      setPreviewLoading(null);
    }
  };

  const createStockJob = async (voice: CatalogVoice) => {
    if (!pdfPath) {
      toast.error("Upload a book first");
      router.push("/");
      return;
    }
    if (extractStatus === "failed") {
      toast.error(
        userFriendlyError(extractError || "Could not read this document.")
      );
      return;
    }
    setCreating(true);
    try {
      let chars = extractChars || charCount || undefined;
      if (uploadId && extractStatus !== "ready") {
        const ready = await waitForUploadExtract(uploadId);
        chars = ready.charCount || chars;
        setExtractChars(ready.charCount ?? 0);
        setExtractStatus("ready");
      }

      const postJob = () =>
        fetch("/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "stock",
            jobKind: "takehome",
            pdfStoragePath: pdfPath,
            bookTitle: pdfName || "Untitled",
            catalogVoiceId: voice.id,
            voiceName: stockDeliveryLabel(voiceTitle(voice), deliveryFor(voice.id)),
            stockDelivery:
              deliveryFor(voice.id) === "expressive" &&
              expressiveChoiceEnabled(voice.expressive)
                ? "expressive"
                : "standard",
            charCount: chars,
            ttsOptions: deliveryPrefToTtsOptions(deliveryPref),
          }),
        });

      let res = await postJob();
      let data = await res.json();
      if (res.status === 409 && data.code === "TEXT_NOT_READY" && uploadId) {
        const ready = await waitForUploadExtract(uploadId);
        chars = ready.charCount || chars;
        setExtractChars(ready.charCount ?? 0);
        setExtractStatus("ready");
        res = await postJob();
        data = await res.json();
      }
      if (!res.ok) throw new Error(data.error || "Failed to create job");

      if (data.duplicate && data.status === "ready") {
        toast.success("Audiobook already ready");
        router.push(`/dashboard/player/${data.jobId}`);
        return;
      }

      toast.success(UX.fullBookStarted);
      router.push(`/dashboard/player/${data.jobId}`);
    } catch (e: unknown) {
      toast.error(
        userFriendlyError(e instanceof Error ? e.message : "Couldn't start narration")
      );
    } finally {
      setCreating(false);
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

  const voiceContinueInput = () => ({
    path: voicePath,
    hasPendingSample: pendingSample,
    qualityVerdict: cloneQuality?.verdict ?? null,
    qualityChecking: cloneQualityChecking,
    busy: creating || cloning,
    hasSelectedVoice: selectedVoice != null,
    hasBook: Boolean(pdfPath),
  });

  const continueVoiceStep = async () => {
    if (continueLockRef.current) return;
    const decision = resolveVoiceContinue(voiceContinueInput());
    if (decision.type === "blocked") {
      if (decision.reason === "quality-fail") {
        toast.error(
          cloneQuality?.headline || "This sample isn't good enough to clone well."
        );
      }
      return;
    }
    if (decision.type === "start-selected") {
      if (!selectedVoice) return;
      continueLockRef.current = true;
      try {
        await createStockJob(selectedVoice);
      } finally {
        continueLockRef.current = false;
      }
      return;
    }
    if (!cloneFile) return;

    continueLockRef.current = true;
    setCloning(true);
    try {
      const clone = await uploadCloneVoice(cloneFile, {
        title: cloneTitle.trim() || "My voice",
        accent: cloneAccent,
      });
      const clonedVoice = catalogVoiceFromClone(clone, cloneAccent);
      setPinnedVoiceId(clonedVoice.id);
      setSelectedVoiceId(clonedVoice.id);
      setAllVoices((prev) =>
        prev.some((voice) => voice.id === clonedVoice.id)
          ? prev
          : [clonedVoice, ...prev]
      );
      setCloneTitle("");
      setCloneAccent(DEFAULT_CLONE_ACCENT);
      clearPendingSample();
      setVoicesReloadToken((n) => n + 1);
      if (decision.type === "clone-only") {
        toast.success(
          `Cloned “${clone.displayName || "voice"}” — ready to narrate.`
        );
        return;
      }
      if (decision.type === "clone-and-start") {
        await createStockJob(clonedVoice);
      }
    } catch (err) {
      toast.error(
        userFriendlyError(
          err instanceof Error ? err.message : "Couldn't clone that voice."
        )
      );
    } finally {
      continueLockRef.current = false;
      setCloning(false);
    }
  };

  const saveCloneAccent = async (voice: CatalogVoice, accent: CloneAccent) => {
    if (cloneAccentOf(voice) === accent) return;
    setSavingAccentId(voice.id);
    try {
      await updateCloneAccent(voice.id, accent);
      toast.success(`${voiceTitle(voice).split("·")[0]?.trim() || "Clone"} · ${CLONE_ACCENT_LABELS[accent]}`);
      setVoicesReloadToken((n) => n + 1);
    } catch (err) {
      toast.error(
        userFriendlyError(
          err instanceof Error ? err.message : "Couldn't update that accent."
        )
      );
    } finally {
      setSavingAccentId(null);
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
    const isSelected = selectedVoiceId === voice.id && !pendingSample;
    const isLoadingPreview = previewLoading === voice.id;
    const expressiveOn =
      isSelected && deliveryFor(voice.id) === "expressive";
    const showExpressive = !cloned && showExpressiveChoice(voice.expressive);
    const expressiveEnabled = expressiveChoiceEnabled(voice.expressive);
    const recommendedOn = (mode: StockDeliveryMode) =>
      narrator
        ? narratorMarksVoice(narrator, voice.id, mode, {
            expressiveAvailable: expressiveEnabled,
          })
        : false;
    const standardLabel = withNarratorRecommendation(
      voiceTitle(voice),
      recommendedOn("standard")
    );
    const expressiveLabel = withNarratorRecommendation(
      stockDeliveryLabel(voiceTitle(voice), "expressive"),
      recommendedOn("expressive")
    );
    const audible = compareSide ?? linePreview;
    const playingStandard = isPlaying && audible === "standard";
    const playingExpressive = isPlaying && audible === "expressive";
    const loadingStandard = isLoadingPreview && audible === "standard";
    const loadingExpressive = isLoadingPreview && audible === "expressive";
    const previewBusyElsewhere =
      (!!previewLoading && previewLoading !== voice.id) ||
      (previewOnCooldown && previewingId !== voice.id);
    const lineClass = (active: boolean) =>
      `flex w-full min-h-11 touch-manipulation items-center gap-1 text-left font-serif text-lg tracking-tight transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`;
    const glyph = (loading: boolean, playing: boolean) =>
      loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : playing ? (
        <Square className="h-3.5 w-3.5" />
      ) : (
        <Play className="h-3.5 w-3.5" />
      );
    return (
      <motion.div key={voice.id} layout className="flex items-start gap-1 py-1">
        <div className="min-w-0 flex-1 text-left">
          <button
            type="button"
            disabled={previewBusyElsewhere}
            aria-pressed={isSelected && !expressiveOn}
            aria-label={`${playingStandard ? UX.liveListenStop : UX.preview} ${standardLabel}`}
            onClick={() => {
              void previewVoice(voice, "standard");
            }}
            className={lineClass(isSelected && !expressiveOn)}
            style={{ fontWeight: 300 }}
          >
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground">
              {glyph(loadingStandard, playingStandard)}
            </span>
            <span className="min-w-0 truncate">{standardLabel}</span>
            {isSelected && !expressiveOn ? (
              <Check
                aria-hidden="true"
                className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground"
                strokeWidth={1.35}
              />
            ) : null}
          </button>
          {showExpressive && expressiveEnabled ? (
            <button
              type="button"
              disabled={previewBusyElsewhere}
              aria-pressed={expressiveOn}
              aria-label={`${playingExpressive ? UX.liveListenStop : UX.preview} ${expressiveLabel}`}
              onClick={() => {
                void previewVoice(voice, "expressive");
              }}
              className={lineClass(expressiveOn)}
              style={{ fontWeight: 300 }}
            >
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground">
                {glyph(loadingExpressive, playingExpressive)}
              </span>
              <span className="min-w-0">{expressiveLabel}</span>
              {expressiveOn ? (
                <Check
                  aria-hidden="true"
                  className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground"
                  strokeWidth={1.35}
                />
              ) : null}
            </button>
          ) : null}
          {showExpressive && !expressiveEnabled ? (
            <div
              aria-disabled="true"
              className="flex min-h-11 items-center gap-1 text-muted-foreground/50"
            >
              <span className="inline-flex h-11 w-11 shrink-0" aria-hidden="true" />
              <span className="min-w-0 font-serif text-lg tracking-tight" style={{ fontWeight: 300 }}>
                {expressiveLabel}
              </span>
              <span className="ml-auto shrink-0 text-[11px]">
                {UX.expressiveUnavailable}
              </span>
            </div>
          ) : null}
          {showExpressive && expressiveEnabled ? (
            <button
              type="button"
              onClick={() => {
                void playBoth(voice);
              }}
              className="inline-flex min-h-11 w-full touch-manipulation items-center pl-11 text-left text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              aria-label={`${isPlaying && compareSide ? UX.liveListenStop : UX.playBoth} for ${voiceTitle(voice)}`}
            >
              {isPlaying && compareSide ? UX.liveListenStop : UX.playBoth}
            </button>
          ) : null}
        </div>
        {cloned ? (
          <button
            type="button"
            disabled={deletingCloneId === voice.id}
            onClick={() => {
              void deleteClone(voice);
            }}
            className="shrink-0 inline-flex min-h-11 min-w-11 touch-manipulation items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Delete cloned voice"
            aria-label="Delete cloned voice"
          >
            {deletingCloneId === voice.id ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </button>
        ) : null}
      </motion.div>
    );
  };

  const heading =
    voicePath === "standard"
      ? VOICE_PATH.standardTitle
      : voicePath === "clone"
        ? VOICE_PATH.cloneTitle
        : null;

  const holdForNarrator =
    voicePath === "standard" && Boolean(uploadId) && !narratorSettled;
  const needsBook = voicePath === "standard" && !pdfPath;
  const stockUnavailable =
    voicePath === "standard" && !loading && pdfPath && pathVoices.length === 0;
  const continueDecision = resolveVoiceContinue(voiceContinueInput());
  const continueLabel =
    continueDecision.type === "clone-only" ? "Clone voice" : UX.makeAudiobook;

  return (
    <div className="max-w-3xl mx-auto pt-2 pb-16 font-sans">
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
            type="button"
            className="inline-flex min-h-11 touch-manipulation items-center gap-2 px-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => router.push("/")}
          >
            <ArrowLeft className="w-3 h-3" />
            <span className="max-w-[180px] truncate">{pdfName}</span>
          </button>
        </div>
      )}
      {extractStatus === "preparing" ? (
        <p className="mb-4 text-right">
          <WaitMark phrases={WAIT.ingest} />
        </p>
      ) : extractStatus === "failed" && extractError ? (
        <p className="text-[11px] text-muted-foreground text-center mb-4">
          {userFriendlyError(extractError)}
        </p>
      ) : null}
      {chapters.length > 0 ? (
        <nav aria-label="Chapters" className="mb-8">
          <ul className="mx-auto max-h-48 max-w-sm space-y-1 overflow-y-auto">
            {chapters.map((chapter) => (
              <li
                key={chapter.index}
                className="truncate text-sm text-muted-foreground"
                style={
                  chapter.level > 1 ? { paddingLeft: "0.75rem" } : undefined
                }
              >
                {chapter.title}
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {!voicePath ? (
        <div className="flex justify-center gap-4 mb-8">
          <button
            type="button"
            onClick={() => setVoicePath("standard")}
            className="inline-flex min-h-11 min-w-36 touch-manipulation items-center justify-center px-6 font-serif text-xl text-muted-foreground hover:text-foreground transition-colors"
            style={{ fontWeight: 300 }}
          >
            {VOICE_PATH.standardTitle}
          </button>
          <button
            type="button"
            onClick={() => setVoicePath("clone")}
            className="inline-flex min-h-11 min-w-36 touch-manipulation items-center justify-center px-6 font-serif text-xl text-muted-foreground hover:text-foreground transition-colors"
            style={{ fontWeight: 300 }}
          >
            {VOICE_PATH.cloneTitle}
          </button>
        </div>
      ) : (
        <>
          <div className="flex justify-center mb-6">
            <button
              type="button"
              onClick={() => setVoicePath(null)}
              className="inline-flex min-h-11 touch-manipulation items-center gap-2 px-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="w-3 h-3" />
              {VOICE_PATH.backToPaths}
            </button>
          </div>

          {voicePath === "clone" && fishCloneConfigured && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-10 space-y-3"
            >
              <div className="space-y-3">
                <input
                  value={cloneTitle}
                  onChange={(e) => setCloneTitle(e.target.value)}
                  placeholder="Name (e.g. Alex)"
                  maxLength={80}
                  disabled={cloning || creating}
                  className="w-full h-11 px-0 border-0 border-b border-border/40 bg-transparent text-sm outline-none focus:border-border disabled:opacity-30"
                />
                <CloneAccentPicker
                  value={cloneAccent}
                  onChange={setCloneAccent}
                  disabled={cloning || creating}
                />
                <input
                  ref={cloneFileRef}
                  type="file"
                  accept="audio/wav,audio/mpeg,audio/mp4,audio/mp3,audio/ogg,audio/webm,.wav,.mp3,.m4a,.opus,.ogg,.webm"
                  disabled={cloning || creating}
                  onChange={(e) =>
                    void onCloneFileChange(e.target.files?.[0] || null)
                  }
                  className="block w-full text-xs text-muted-foreground file:mr-3 file:py-1.5 file:px-0 file:border-0 file:bg-transparent file:text-foreground file:text-xs disabled:opacity-30"
                />
              </div>
              {cloneFile && (
                <p className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="truncate">
                    Sample: {cloneFile.name} ({Math.round(cloneFile.size / 1024)} KB)
                  </span>
                  <button
                    type="button"
                    onClick={clearPendingSample}
                    disabled={cloning || creating}
                    className="inline-flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
                    aria-label="Remove sample"
                  >
                    <X className="h-3 w-3" />
                    Remove
                  </button>
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

          {loading || holdForNarrator ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : needsBook ? (
            <div className="text-center py-16 space-y-4">
              <p className="text-sm text-muted-foreground">
                Upload or paste text first.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-6 text-sm">
                <button
                  type="button"
                  onClick={() => router.push("/")}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  New audiobook
                </button>
                <button
                  type="button"
                  onClick={() => router.push("/dashboard/queue")}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  Library
                </button>
              </div>
            </div>
          ) : stockUnavailable ? (
            <div className="text-center py-16 border border-dashed border-border/50 rounded-sm">
              <p className="text-muted-foreground">Voices unavailable right now.</p>
            </div>
          ) : pathVoices.length === 0 && !pendingSample ? (
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
              className="pb-28 md:pb-16"
            >
              {pathVoices.length === 0 ? (
                <p className="text-center text-muted-foreground py-8 font-serif">
                  {VOICE_PATH.noClones}
                </p>
              ) : (
                <div className="mx-auto max-w-sm divide-y divide-border/40">
                  {pathVoices.map((voice) => renderVoiceCard(voice))}
                </div>
              )}
              {selectedVoice && isClonedVoice(selectedVoice) && !pendingSample ? (
                <div className="flex justify-center pt-6">
                  <CloneAccentPicker
                    label={`Accent for ${voiceTitle(selectedVoice)}`}
                    value={cloneAccentOf(selectedVoice)}
                    disabled={savingAccentId === selectedVoice.id}
                    onChange={(accent) => void saveCloneAccent(selectedVoice, accent)}
                  />
                </div>
              ) : null}
              <div className="flex justify-center pt-8 pb-4">
                <button
                  type="button"
                  aria-label={continueLabel}
                  disabled={continueDecision.type === "blocked"}
                  onClick={() => void continueVoiceStep()}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center text-foreground hover:opacity-70 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {creating || cloning ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <ChevronRight
                      aria-hidden="true"
                      className="h-6 w-6"
                      strokeWidth={1.35}
                    />
                  )}
                </button>
              </div>
            </motion.div>
          )}
        </>
      )}
    </div>
  );
}
