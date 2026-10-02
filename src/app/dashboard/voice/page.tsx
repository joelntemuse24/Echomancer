"use client";

import {
  Loader2,
  ArrowLeft,
  Play,
  Square,
  Trash2,
  Check,
  X,
} from "lucide-react";
import { useState, useEffect, useLayoutEffect, useRef, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { userFriendlyError } from "@/lib/errors-ui";
import { cloneNameOrFallback } from "@/lib/clone-name";
import {
  CloneQualityRiskError,
  completeCloneUpload,
  uploadCloneVoice,
  type CloneQualityRisk,
  uploadIdFromStoragePath,
  waitForUploadExtract,
  type UploadChapter,
  type UploadedCloneVoice,
} from "@/lib/upload-client";
import { DEFAULT_CLONE_ACCENT } from "@/lib/tts/clone-accent";
import { toast } from "sonner";
import { motion } from "motion/react";
import { PREVIEW_TEXT, sniffPreviewMime } from "@/lib/tts/preview-text";
import {
  narratorMarksVoice,
  withNarratorRecommendation,
  type NarratorRecommendation,
} from "@/lib/tts/narrator-suggestion";
import {
  cancelBrowserSpeech,
  speakPreviewForStockVoice,
} from "@/lib/tts/browser-speech";
import {
  isEdgeStockVoice,
  isSlimStockVoiceId,
  SLIM_STOCK_VOICE_IDS,
} from "@/lib/tts/standard-voice";
import { stockPreviewUrl } from "@/lib/tts/stock-preview";
import {
  readStockVoicePick,
  resolveStockSelection,
  writeStockVoicePick,
} from "@/lib/stock-voice-pick";
import { isCuratedFishStockVoice } from "@/lib/tts/curated-fish-stock";
import { WaitMark } from "@/components/wait-mark";
import { UX, VOICE_PATH, WAIT } from "@/lib/ux-copy";
import { YoutubeClipPicker } from "@/components/youtube-clip-picker";
import { CloneQualityRiskNotice } from "@/components/clone-quality-risk";
import { YOUTUBE_COPY } from "@/lib/youtube/messages";
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
import { prepareCloneSampleFile } from "@/lib/tts/clone-sample-quality-browser";

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
}

function voiceTitle(v: CatalogVoice): string {
  return v.friendlyName || v.displayName;
}

function isClonedVoice(v: CatalogVoice): boolean {
  return isUserCloneVoice(v);
}

function catalogVoiceFromClone(clone: UploadedCloneVoice): CatalogVoice {
  const name = cloneNameOrFallback(clone.displayName);
  return {
    id: clone.catalogVoiceId,
    provider: "fish",
    displayName: name,
    friendlyName: name,
    accent: DEFAULT_CLONE_ACCENT,
    language: "en",
    locale: "en",
    gender: "",
    style: "",
    tags: ["cloned"],
    model: "",
    latencyClass: "",
  };
}

/** A book name that is only rules or an extension reads as a back link, not a line. */
function bookLinkLabel(name: string): string {
  const stripped = name
    .replace(/\.[A-Za-z0-9]{2,5}$/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.replace(/[^A-Za-z0-9]/g, "").length < 2) return "Book";
  return stripped;
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
  const [pinnedVoiceId, setPinnedVoiceId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [fishCloneConfigured, setFishCloneConfigured] = useState<boolean | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewCooldownUntil, setPreviewCooldownUntil] = useState<number>(0);
  const [cooldownTick, setCooldownTick] = useState(0);
  const [deliveryPref, setDeliveryPref] = useState<DeliveryPref>(
    DEFAULT_DELIVERY_PREF
  );
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneQuality, setCloneQuality] = useState<CloneSampleQualityReport | null>(
    null
  );
  const [cloneQualityChecking, setCloneQualityChecking] = useState(false);
  /** Worker gate said "may not clone well"; the sample is already uploaded. */
  const [cloneRisk, setCloneRisk] = useState<{
    uploadId: string;
    risk: CloneQualityRisk;
    startBook: boolean;
  } | null>(null);
  const [cloning, setCloning] = useState(false);
  const [deletingCloneId, setDeletingCloneId] = useState<string | null>(null);
  const [voicesReloadToken, setVoicesReloadToken] = useState(0);
  const [extractStatus, setExtractStatus] = useState<
    "ready" | "preparing" | "failed"
  >(charCount > 0 || !uploadId ? "ready" : "preparing");
  const [extractChars, setExtractChars] = useState(charCount);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [chapters, setChapters] = useState<UploadChapter[]>([]);
  const [narrator, setNarrator] = useState<NarratorRecommendation | null>(null);
  const [narratorSettled, setNarratorSettled] = useState(!uploadId);
  const [narratorPending, setNarratorPending] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const browserSpeechActiveRef = useRef(false);
  const previewCacheRef = useRef<Map<string, { url: string; mime: string }>>(
    new Map()
  );
  const cloneFileRef = useRef<HTMLInputElement | null>(null);
  const continueLockRef = useRef(false);
  const narratorTouchedRef = useRef(false);
  const stockPickRef = useRef<ReturnType<typeof readStockVoicePick>>(null);

  useLayoutEffect(() => {
    const pick = readStockVoicePick();
    if (!pick || !isSlimStockVoiceId(pick.catalogVoiceId)) return;
    stockPickRef.current = pick;
    narratorTouchedRef.current = true;
    setSelectedVoiceId(pick.catalogVoiceId);
  }, []);

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
          err instanceof Error ? err.message : "Couldn't read this document. Try another file."
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
    let timer = 0;
    const pull = () => {
      void fetch(`/api/pdf/upload/${uploadId}/narrator`)
        .then(async (res) => {
          if (!res.ok || cancelled) return;
          const data = (await res.json()) as {
            narrator?: NarratorRecommendation | null;
            pending?: boolean;
          };
          if (data.narrator?.catalogVoiceId) setNarrator(data.narrator);
          const pending = data.pending === true && !data.narrator?.catalogVoiceId;
          setNarratorPending(pending);
          if (!pending) {
            window.clearInterval(timer);
            setNarratorSettled(true);
          }
        })
        .catch(() => {
          if (!cancelled) setNarratorSettled(true);
        });
    };
    pull();
    timer = window.setInterval(pull, 2_500);
    const stop = window.setTimeout(() => {
      window.clearInterval(timer);
      if (!cancelled) {
        setNarratorPending(false);
        setNarratorSettled(true);
      }
    }, 90_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(stop);
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

  useEffect(() => {
    const warmed: HTMLAudioElement[] = [];
    for (const id of SLIM_STOCK_VOICE_IDS) {
      const url = stockPreviewUrl(id);
      if (!url) continue;
      const audio = new Audio();
      audio.preload = "auto";
      audio.src = url;
      warmed.push(audio);
    }
    return () => {
      for (const audio of warmed) audio.src = "";
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
      .catch(() => toast.error("Couldn't load voices. Refresh and try again."))
      .finally(() => setLoading(false));
  }, [voicesReloadToken]);

  const voicePath = parseVoicePath(searchParams.get("path"));
  // No path opens the Standard pile. Clone stays an explicit choice.
  const activePath: VoicePath = voicePath === "clone" ? "clone" : "standard";
  const pathVoices = useMemo(
    () => voicesForPath(allVoices, activePath),
    [allVoices, activePath]
  );
  const stockVoices = useMemo(
    () => voicesForPath(allVoices, "standard"),
    [allVoices]
  );
  const cloneVoices = useMemo(
    () => voicesForPath(allVoices, "clone"),
    [allVoices]
  );
  const selectedVoice =
    pathVoices.find((voice) => voice.id === selectedVoiceId) ?? null;
  const pendingSample =
    activePath === "clone" && fishCloneConfigured === true && cloneFile != null;

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
    if (loading) return;
    if (activePath === "clone") {
      if (pathVoices.some((voice) => voice.id === selectedVoiceId)) return;
      // A tap on a stock name leaves the clone row. Don't snap back to a clone
      // before the path query updates.
      if (
        selectedVoiceId &&
        isSlimStockVoiceId(selectedVoiceId) &&
        narratorTouchedRef.current
      ) {
        return;
      }
      setSelectedVoiceId(pathVoices[0]?.id ?? null);
      return;
    }
    const explicitId = narratorTouchedRef.current
      ? pathVoices.some((voice) => voice.id === selectedVoiceId)
        ? selectedVoiceId
        : stockPickRef.current?.catalogVoiceId
      : null;
    const next = resolveStockSelection({
      availableIds: pathVoices.map((voice) => voice.id),
      explicitId,
      suggestedId: narrator?.catalogVoiceId,
    });
    if (next !== selectedVoiceId) setSelectedVoiceId(next);
  }, [pathVoices, selectedVoiceId, pinnedVoiceId, loading, activePath, narrator]);

  const setVoicePath = (path: VoicePath | null) => {
    setPinnedVoiceId(null);
    if (path === "clone") narratorTouchedRef.current = false;
    const q = withVoicePathParam(searchParams.toString(), path);
    const qs = q.toString();
    router.push(qs ? `/dashboard/voice?${qs}` : "/dashboard/voice");
  };

  const clearPendingSample = () => {
    setCloneRisk(null);
    setCloneFile(null);
    setCloneQuality(null);
    setCloneQualityChecking(false);
    if (cloneFileRef.current) cloneFileRef.current.value = "";
  };

  const selectVoice = (id: string, opts?: { dismissSample?: boolean }) => {
    setPinnedVoiceId(null);
    setSelectedVoiceId(id);
    if (opts?.dismissSample) clearPendingSample();
    if (!isSlimStockVoiceId(id)) return;
    narratorTouchedRef.current = true;
    const pick = {
      catalogVoiceId: id,
      delivery: "standard" as const,
    };
    stockPickRef.current = pick;
    writeStockVoicePick(pick);
    if (activePath === "clone") setVoicePath(null);
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
    if (
      previewingId === voice.id &&
      (previewAudioRef.current || browserSpeechActiveRef.current || previewLoading === voice.id)
    ) {
      stopPreviewPlayback();
      return;
    }
    if (Date.now() < previewCooldownUntil) {
      toast.error("Wait a moment.");
      return;
    }
    stopPreviewPlayback();
    selectVoice(voice.id, { dismissSample: true });
    setPreviewingId(voice.id);

    const recorded = isSlimStockVoiceId(voice.id)
      ? stockPreviewUrl(voice.id)
      : null;
    if (recorded) {
      setPreviewLoading(voice.id);
      try {
        const audio = new Audio(recorded);
        audio.onended = () => setPreviewingId(null);
        previewAudioRef.current = audio;
        await audio.play();
        setPreviewLoading(null);
        return;
      } catch {
        previewAudioRef.current = null;
      }
    }

    const playUrl = async (url: string) => {
      const audio = new Audio(url);
      audio.onended = () => {
        setPreviewingId(null);
      };
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
        toast.error(e instanceof Error ? e.message : "Couldn't play the sample. Try again.");
        setPreviewingId(null);
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
        };
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
        toast.error(e instanceof Error ? e.message : "Couldn't play the sample. Try again.");
      }
      return;
    }

    const cached = previewCacheRef.current.get(voice.id);
    if (cached) {
      try {
        await playUrl(cached.url);
      } catch (e: unknown) {
        setPreviewingId(null);
        toast.error(e instanceof Error ? e.message : "Couldn't play the sample. Try again.");
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
        throw new Error("That sample was empty. Try again.");
      }
      const mime = sniffPreviewMime(buf, headerType);
      const blob = new Blob([buf], { type: mime });
      const url = URL.createObjectURL(blob);
      previewCacheRef.current.set(voice.id, { url, mime });
      await playUrl(url);
    } catch (e: unknown) {
      setPreviewingId(null);
      toast.error(e instanceof Error ? e.message : "Couldn't play the sample. Try again.");
    } finally {
      setPreviewLoading(null);
    }
  };

  const createStockJob = async (voice: CatalogVoice) => {
    if (!pdfPath) {
      if (isSlimStockVoiceId(voice.id)) {
        const pick = {
          catalogVoiceId: voice.id,
          delivery: "standard" as const,
        };
        stockPickRef.current = pick;
        writeStockVoicePick(pick);
      }
      router.push("/");
      return;
    }
    if (extractStatus === "failed") {
      setStartError(
        userFriendlyError(extractError || "Couldn't read this document. Try another file.")
      );
      return;
    }
    setStartError(null);
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
            voiceName: voiceTitle(voice),
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
      if (!res.ok) throw new Error(data.error || "Couldn't start. Try again.");

      router.push(`/dashboard/player/${data.jobId}`);
    } catch (e: unknown) {
      setStartError(
        userFriendlyError(e instanceof Error ? e.message : "Couldn't start. Try again.")
      );
    } finally {
      setCreating(false);
    }
  };

  const onCloneFileChange = async (file: File | null) => {
    setCloneRisk(null);
    setCloneFile(file);
    setCloneQuality(null);
    if (!file) {
      setCloneQualityChecking(false);
      return;
    }
    setCloneQualityChecking(true);
    try {
      const prepared = await prepareCloneSampleFile(file);
      setCloneFile(prepared.file);
      setCloneQuality(prepared.report);
      const report = prepared.report;
      if (report?.verdict === "fail") {
        toast.error(report.headline);
      }
    } finally {
      setCloneQualityChecking(false);
    }
  };

  const voiceContinueInput = () => ({
    path: activePath,
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
          cloneQuality?.headline || "Too much echo to clone."
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
    const startBook = decision.type === "clone-and-start";
    try {
      const clone = await uploadCloneVoice(cloneFile, {
        title: cloneNameOrFallback(cloneFile.name),
        accent: DEFAULT_CLONE_ACCENT,
      });
      await finishClonedVoice(clone, startBook);
    } catch (err) {
      if (err instanceof CloneQualityRiskError) {
        setCloneRisk({ uploadId: err.uploadId, risk: err.risk, startBook });
        return;
      }
      toast.error(
        userFriendlyError(
          err instanceof Error ? err.message : "Couldn't clone that voice. Try another sample."
        )
      );
    } finally {
      continueLockRef.current = false;
      setCloning(false);
    }
  };

  /** "Continue anyway" on the quality warning: clone the uploaded sample. */
  const continueRiskyClone = async () => {
    if (!cloneRisk || continueLockRef.current) return;
    const { uploadId, startBook } = cloneRisk;
    continueLockRef.current = true;
    setCloning(true);
    try {
      const clone = await completeCloneUpload(
        uploadId,
        { title: cloneNameOrFallback(cloneFile?.name), accent: DEFAULT_CLONE_ACCENT },
        { acceptQualityRisk: true }
      );
      setCloneRisk(null);
      await finishClonedVoice(clone, startBook);
    } catch (err) {
      toast.error(
        userFriendlyError(
          err instanceof Error ? err.message : "Couldn't clone that voice. Try another sample."
        )
      );
    } finally {
      continueLockRef.current = false;
      setCloning(false);
    }
  };

  const finishClonedVoice = async (clone: UploadedCloneVoice, startBook: boolean) => {
    const clonedVoice = catalogVoiceFromClone(clone);
    setPinnedVoiceId(clonedVoice.id);
    setSelectedVoiceId(clonedVoice.id);
    setAllVoices((prev) =>
      prev.some((voice) => voice.id === clonedVoice.id)
        ? prev
        : [clonedVoice, ...prev]
    );
    clearPendingSample();
    setVoicesReloadToken((n) => n + 1);
    if (!startBook) {
      toast.success(`${clone.displayName || "Voice"} is ready.`);
      return;
    }
    await createStockJob(clonedVoice);
  };

  const adoptClonedVoice = (clone: UploadedCloneVoice) => {
    const clonedVoice = catalogVoiceFromClone(clone);
    setPinnedVoiceId(clonedVoice.id);
    setSelectedVoiceId(clonedVoice.id);
    setAllVoices((prev) =>
      prev.some((voice) => voice.id === clonedVoice.id)
        ? prev
        : [clonedVoice, ...prev]
    );
    clearPendingSample();
    setVoicesReloadToken((n) => n + 1);
    toast.success(`${clone.displayName || "Voice"} is ready.`);
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
        throw new Error(data.error || "Couldn't delete that clone. Try again.");
      }
      toast.success("Clone removed.");
      setVoicesReloadToken((n) => n + 1);
    } catch (err) {
      toast.error(
        userFriendlyError(
          err instanceof Error ? err.message : "Couldn't delete that clone. Try again."
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
    const label = withNarratorRecommendation(
      voiceTitle(voice),
      narrator ? narratorMarksVoice(narrator, voice.id) : false
    );
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
      <motion.div key={voice.id} layout className="flex items-start gap-1 py-3">
        <div className="min-w-0 flex-1 text-left">
          <button
            type="button"
            disabled={previewBusyElsewhere}
            aria-pressed={isSelected}
            aria-label={`${isPlaying ? UX.liveListenStop : UX.preview} ${label}`}
            onClick={() => {
              void previewVoice(voice);
            }}
            className={lineClass(isSelected)}
            style={{ fontWeight: 300 }}
          >
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground">
              {glyph(isLoadingPreview, isPlaying)}
            </span>
            <span className="min-w-0 truncate">{label}</span>
            {isSelected ? (
              <Check
                aria-hidden="true"
                className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground"
                strokeWidth={1.35}
              />
            ) : null}
          </button>
        </div>
        {cloned ? (
          <button
            type="button"
            disabled={deletingCloneId === voice.id}
            onClick={() => {
              void deleteClone(voice);
            }}
            className="shrink-0 inline-flex min-h-11 min-w-11 touch-manipulation items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Delete"
            aria-label="Delete"
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

  const showNarratorWait =
    Boolean(uploadId) && narratorPending && !narratorSettled;
  const stockUnavailable = !loading && stockVoices.length === 0;
  const continueDecision = resolveVoiceContinue(voiceContinueInput());
  const continueLabel =
    continueDecision.type === "clone-only" ? "Clone voice" : UX.makeAudiobook;
  const showContinue =
    !loading &&
    (pendingSample ||
      (activePath === "clone"
        ? cloneVoices.length > 0
        : stockVoices.length > 0));

  return (
    <div className="mx-auto max-w-xl px-2 pb-28 pt-10 font-sans md:pb-20">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-16 text-center"
      >
        <h1
          className="font-serif text-5xl tracking-tight md:text-6xl"
          style={{ fontWeight: 300 }}
        >
          {VOICE_PATH.title}
        </h1>
      </motion.div>

      {pdfName && (
        <div className="mb-10 flex justify-center">
          <button
            type="button"
            aria-label={`Back, ${bookLinkLabel(pdfName)}`}
            className="inline-flex min-h-11 max-w-full touch-manipulation items-center gap-2 px-3 text-sm text-foreground/80 transition-colors hover:text-foreground"
            onClick={() => router.push("/")}
          >
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{bookLinkLabel(pdfName)}</span>
          </button>
        </div>
      )}
      {extractStatus === "failed" && extractError ? (
        <p className="mb-8 text-center text-sm text-muted-foreground">
          {userFriendlyError(extractError)}
        </p>
      ) : null}
      {chapters.length > 0 ? (
        <nav aria-label="Chapters" className="mb-14">
          <ul className="mx-auto max-h-48 max-w-sm space-y-2 overflow-y-auto">
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

      {loading ? (
        <div className="flex justify-center py-20">
          {extractStatus === "preparing" ? (
            <WaitMark phrases={WAIT.ingest} />
          ) : (
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          )}
        </div>
      ) : stockUnavailable ? (
        <p className="py-16 text-center text-muted-foreground">
          {VOICE_PATH.stockUnavailable}
        </p>
      ) : (
        <>
          {showNarratorWait ? (
            <div className="flex justify-center pb-10">
              <WaitMark phrases={WAIT.ingest} />
            </div>
          ) : null}
          <div className="mx-auto max-w-sm divide-y divide-border/40">
            {stockVoices.map((voice) => renderVoiceCard(voice))}
          </div>
        </>
      )}

      <div className="mx-auto mt-12 max-w-sm">
        <button
          type="button"
          aria-expanded={activePath === "clone"}
          onClick={() => setVoicePath(activePath === "clone" ? null : "clone")}
          className={`flex min-h-11 w-full items-center font-serif text-lg tracking-tight transition-colors ${
            activePath === "clone"
              ? "border-b border-foreground text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          style={{ fontWeight: 300 }}
        >
          {VOICE_PATH.cloneTitle}
        </button>
      </div>

      {activePath === "clone" && fishCloneConfigured && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mx-auto mb-6 mt-8 max-w-sm space-y-6"
        >
          <YoutubeClipPicker
            disabled={cloning || creating}
            onBusy={setCloning}
            onCloned={adoptClonedVoice}
            onUploadInstead={() => cloneFileRef.current?.click()}
          />
          <input
            ref={cloneFileRef}
            type="file"
            accept="audio/wav,audio/mpeg,audio/mp4,audio/mp3,audio/ogg,audio/webm,.wav,.mp3,.m4a,.opus,.ogg,.webm"
            disabled={cloning || creating}
            onChange={(e) =>
              void onCloneFileChange(e.target.files?.[0] || null)
            }
            className="sr-only"
            aria-label={YOUTUBE_COPY.orUpload}
          />
          <button
            type="button"
            disabled={cloning || creating}
            onClick={() => cloneFileRef.current?.click()}
            className="tap text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
          >
            {YOUTUBE_COPY.orUpload}
          </button>
          {cloneFile && (
            <p className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="truncate">
                {cloneFile.name} · {Math.round(cloneFile.size / 1024)} KB
              </span>
              <button
                type="button"
                onClick={clearPendingSample}
                disabled={cloning || creating}
                className="tap inline-flex shrink-0 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                aria-label="Remove"
              >
                <X className="h-3 w-3" />
                Remove
              </button>
            </p>
          )}
          {cloneQualityChecking && (
            <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Checking…
            </p>
          )}
          {cloneQuality?.verdict === "fail" && (
            <div className="space-y-1 border border-red-500/30 bg-red-500/5 px-3 py-3">
              <p className="text-sm text-red-700 dark:text-red-400">
                {cloneQuality.headline}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {cloneQuality.primary_message}
              </p>
              {cloneQuality.fails.some(
                (f) =>
                  f.code === "too_reverberant" || f.code === "echo_in_speech"
              ) ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {CLONE_SAMPLE_QUALITY_COPY.reverbDetail}
                </p>
              ) : (
                cloneQuality.fails[0]?.detail && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {cloneQuality.fails[0].detail}
                  </p>
                )
              )}
            </div>
          )}
          {cloneRisk && (
            <CloneQualityRiskNotice
              risk={cloneRisk.risk}
              busy={cloning || creating}
              onChooseAnother={() => {
                clearPendingSample();
                cloneFileRef.current?.click();
              }}
              onContinue={() => void continueRiskyClone()}
            />
          )}
          {!cloneRisk && cloneQuality?.verdict === "warn" && (
            <div className="space-y-1 border border-amber-500/30 bg-amber-500/5 px-3 py-3">
              <p className="text-sm text-amber-800 dark:text-amber-300">
                {cloneQuality.headline}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {cloneQuality.primary_message}
              </p>
            </div>
          )}
        </motion.div>
      )}

      {activePath === "clone" && fishCloneConfigured === false && (
        <p className="mx-auto mt-8 max-w-sm text-center text-sm text-muted-foreground">
          {VOICE_PATH.cloneUnavailable}
        </p>
      )}

      {activePath === "clone" && cloneVoices.length > 0 ? (
        <div className="mx-auto mt-12 max-w-sm">
          <p className="pb-2 text-xs text-muted-foreground">{VOICE_PATH.yourVoices}</p>
          <div className="divide-y divide-border/40">
            {cloneVoices.map((voice) => renderVoiceCard(voice))}
          </div>
        </div>
      ) : null}

      {showContinue ? (
        <div className="flex justify-center pb-4 pt-16">
          <button
            type="button"
            aria-label={continueLabel}
            disabled={continueDecision.type === "blocked"}
            onClick={() => void continueVoiceStep()}
            className="inline-flex min-h-11 items-center justify-center gap-2 border-b border-foreground px-1 pb-1 font-serif text-lg tracking-tight text-foreground transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-30"
            style={{ fontWeight: 300 }}
          >
            {creating || cloning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            {continueLabel}
          </button>
        </div>
      ) : null}
      {startError ? (
        <p className="text-center text-sm text-muted-foreground" role="status">
          {startError}
        </p>
      ) : null}
    </div>
  );
}
