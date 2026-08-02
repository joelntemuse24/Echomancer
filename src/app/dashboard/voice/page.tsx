"use client";

import { Button } from "@/components/ui/button";
import {
  Loader2,
  ArrowLeft,
  Headphones,
  Download,
  Crown,
  Search,
  Play,
  Square,
  RotateCcw,
} from "lucide-react";
import { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { userFriendlyError } from "@/lib/errors-ui";
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

function isHd(v: CatalogVoice): boolean {
  return (
    v.model.toLowerCase().includes("minimax") ||
    v.tags.some((t) => t.toLowerCase() === "hd")
  );
}

function isResearchPreview(v: CatalogVoice): boolean {
  return (
    v.provider === "research" ||
    v.tags.some((t) => t.toLowerCase() === "research-preview")
  );
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
  const [accents, setAccents] = useState<Array<{ id: AccentId; label: string }>>([]);
  const [vibes, setVibes] = useState<Array<{ id: VibeId; label: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [intent, setIntent] = useState<Intent>("listen");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [genderFilter, setGenderFilter] = useState<string>("all");
  const [accentFilter, setAccentFilter] = useState<string>("all");
  const [vibeFilter, setVibeFilter] = useState<string>("all");
  const [creating, setCreating] = useState<string | null>(null);
  const [openRouterConfigured, setOpenRouterConfigured] = useState<boolean | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewCooldownUntil, setPreviewCooldownUntil] = useState<number>(0);
  const [cooldownTick, setCooldownTick] = useState(0);
  const [recent, setRecent] = useState<RecentVoice[]>([]);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewCacheRef = useRef<Map<string, { url: string; mime: string }>>(
    new Map()
  );

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
    const params = new URLSearchParams();
    if (charCount > 0) params.set("charCount", String(charCount));
    fetch(`/api/tts/voices?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        setAllVoices(data.voices || []);
        setListenVoices(data.listenVoices || data.voices || []);
        setAccents(data.accents || []);
        setVibes(data.vibes || []);
        setOpenRouterConfigured(
          typeof data.openRouterKeyConfigured === "boolean"
            ? data.openRouterKeyConfigured
            : null
        );
      })
      .catch(() => toast.error("Couldn't load narrators. Please refresh and try again."))
      .finally(() => setLoading(false));
  }, [charCount]);

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
    let result = pool;
    if (genderFilter !== "all") {
      result = result.filter((v) => v.gender.toLowerCase() === genderFilter);
    }
    if (accentFilter !== "all") {
      result = result.filter((v) => v.accent === accentFilter);
    }
    if (intent === "full" && vibeFilter !== "all") {
      result = result.filter((v) => v.vibe === vibeFilter);
    }
    if (debouncedQuery.trim()) {
      const q = debouncedQuery.toLowerCase();
      result = result.filter(
        (v) =>
          voiceTitle(v).toLowerCase().includes(q) ||
          voiceMeta(v).toLowerCase().includes(q) ||
          v.locale.toLowerCase().includes(q) ||
          v.gender.toLowerCase().includes(q) ||
          v.style.toLowerCase().includes(q) ||
          (v.tags || []).some((t) => t.toLowerCase().includes(q))
      );
    }
    return result;
  }, [pool, genderFilter, accentFilter, vibeFilter, debouncedQuery, intent]);

  const grouped = useMemo(() => {
    if (intent === "listen") return null;
    const groups: Record<string, CatalogVoice[]> = {};
    for (const v of filteredVoices) {
      const accent = accents.find((a) => a.id === v.accent)?.label || "Other";
      const gender =
        v.gender === "female" ? "Female" : v.gender === "male" ? "Male" : "Neutral";
      const key =
        v.accent === "other" && v.language !== "English"
          ? v.language
          : `${accent} ${gender}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(v);
    }
    return Object.entries(groups).sort(([a], [b]) => {
      const order = [
        "American Female",
        "American Male",
        "American Neutral",
        "British Female",
        "British Male",
        "British Neutral",
        "Australian Female",
        "Australian Male",
        "Irish Female",
        "Irish Male",
      ];
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      }
      return a.localeCompare(b);
    });
  }, [filteredVoices, intent, accents]);

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
      toast.error(`Please wait ${secs}s before previewing another voice.`);
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
        toast.error("Couldn't play this preview. Try another narrator.");
      };
      previewAudioRef.current = audio;
      setPreviewingId(voice.id);
      rememberHeard(voice);
      await audio.play();
    };

    const cached = previewCacheRef.current.get(voice.id);
    if (cached) {
      try {
        await playUrl(cached.url);
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Preview failed");
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
        throw new Error(userFriendlyError(data.error || "Preview failed"));
      }
      const headerType = res.headers.get("content-type") || "";
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 256) {
        throw new Error("Preview audio was empty. Try another narrator.");
      }
      const mime = sniffPreviewMime(buf, headerType);
      const blob = new Blob([buf], { type: mime });
      const url = URL.createObjectURL(blob);
      previewCacheRef.current.set(voice.id, { url, mime });
      await playUrl(url);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Preview failed");
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
        router.push(`/dashboard/queue`);
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
    setGenderFilter("all");
    setAccentFilter("all");
    setVibeFilter("all");
  };

  const renderVoiceCard = (voice: CatalogVoice, mode: Intent) => {
    const hd = isHd(voice);
    const isPlaying = previewingId === voice.id;
    const isLoadingPreview = previewLoading === voice.id;
    return (
      <motion.div
        key={voice.id}
        layout
        className={`border rounded-sm p-4 transition-colors ${
          isPlaying
            ? "border-[#D97757]/50 bg-[#D97757]/5"
            : hd
              ? "border-[#D97757]/30 bg-[#D97757]/5 hover:border-[#D97757]/60"
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
              {isResearchPreview(voice) ? (
                <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm bg-amber-500/15 text-amber-700 dark:text-amber-400">
                  Research preview
                </span>
              ) : hd ? (
                <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm bg-[#D97757]/20 text-[#D97757]">
                  <Crown className="w-3 h-3" />
                  HD
                </span>
              ) : null}
              {mode === "listen" && voice.latencyClass === "fast" && (
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Quick start
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
            {mode === "listen" && voice.latencyClass === "quality" && (
              <p className="text-xs mt-2 text-muted-foreground">
                Richer voice — may take a moment longer to start
              </p>
            )}
            <p className="text-[10px] text-muted-foreground/70 mt-2 sm:hidden">
              Tap name to preview
            </p>
          </button>
          <div className="flex flex-wrap gap-2 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              disabled={
                (!!previewLoading && previewLoading !== voice.id) ||
                previewOnCooldown
              }
              onClick={() => previewVoice(voice)}
              className="gap-1.5 px-2.5"
              title="Preview voice"
            >
              {isLoadingPreview ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : isPlaying ? (
                <Square className="w-3.5 h-3.5" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">
                {isPlaying ? "Stop" : "Preview"}
              </span>
            </Button>
            {mode === "listen" ? (
              <Button
                size="sm"
                disabled={!!creating}
                onClick={() => createStockJob(voice, "stream")}
                className="gap-1.5"
              >
                {creating === `${voice.id}-stream` ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Headphones className="w-3.5 h-3.5" />
                )}
                {UX.startListening}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!!creating}
                onClick={() => createStockJob(voice, "takehome")}
                className="gap-1.5"
              >
                {creating === `${voice.id}-takehome` ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                {UX.wholeBookShort}
              </Button>
            )}
          </div>
        </div>
      </motion.div>
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
          Pick by accent and style — Gemini voices include American, British,
          Australian, and Irish.
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

      <div className="flex gap-1 mb-4 p-1 rounded-sm border border-border bg-accent/30">
        <button
          onClick={() => {
            setIntent("listen");
            resetFilters();
          }}
          className={`flex-1 py-2.5 text-sm rounded-sm transition-all inline-flex items-center justify-center gap-2 ${
            intent === "listen"
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Headphones className="w-3.5 h-3.5" />
          {UX.tryChapter}
        </button>
        <button
          onClick={() => {
            setIntent("full");
            resetFilters();
          }}
          className={`flex-1 py-2.5 text-sm rounded-sm transition-all inline-flex items-center justify-center gap-2 ${
            intent === "full"
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Download className="w-3.5 h-3.5" />
          {UX.wholeBook}
        </button>
      </div>

      <p className="text-xs text-muted-foreground text-center mb-6 leading-relaxed">
        {intent === "listen" ? UX.tryChapterBlurb : UX.wholeBookBlurb}{" "}
        {UX.previewHint}
      </p>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !pdfPath ? (
        <div className="text-center py-16 border border-dashed border-border/50 rounded-sm space-y-3">
          <p className="text-muted-foreground">Upload a book to choose a narrator.</p>
          <Button onClick={() => router.push("/")} className="gap-2">
            <ArrowLeft className="w-3.5 h-3.5" />
            Upload a book
          </Button>
        </div>
      ) : pool.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-border/50 rounded-sm">
          <p className="text-muted-foreground">Narrators unavailable right now.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            {openRouterConfigured === false
              ? "Please try again later — our voice catalog is temporarily offline."
              : "Please refresh the page or try again in a few minutes."}
          </p>
        </div>
      ) : (
        <>
          <AnimatePresence>
            {recent.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mb-6 p-4 rounded-sm border border-border/60 bg-accent/20"
              >
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
              </motion.div>
            )}
          </AnimatePresence>

          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                intent === "listen"
                  ? "Search quick narrators…"
                  : "Search by name, accent, or style…"
              }
              className="w-full h-10 pl-9 pr-3 rounded-sm border border-border bg-background text-sm"
            />
          </div>

          <div className="flex flex-wrap gap-2 mb-6">
            <div className="inline-flex gap-1 flex-wrap">
              {["all", "female", "male"].map((g) => (
                <button
                  key={g}
                  onClick={() => setGenderFilter(g)}
                  className={`px-3 py-1 text-xs rounded-sm border transition-colors capitalize ${
                    genderFilter === g
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {g === "all" ? "Any gender" : g}
                </button>
              ))}
            </div>

            {accents.length > 0 && (
              <select
                value={accentFilter}
                onChange={(e) => setAccentFilter(e.target.value)}
                className="h-7 px-2 text-xs rounded-sm border border-border bg-background text-muted-foreground"
              >
                <option value="all">Any accent</option>
                {accents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            )}

            {intent === "full" && vibes.length > 0 && (
              <select
                value={vibeFilter}
                onChange={(e) => setVibeFilter(e.target.value)}
                className="h-7 px-2 text-xs rounded-sm border border-border bg-background text-muted-foreground"
              >
                <option value="all">Any style</option>
                {vibes.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          <motion.div
            key={intent}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {filteredVoices.length === 0 ? (
              <p className="text-center text-muted-foreground py-12">
                {debouncedQuery.trim()
                  ? `No narrators match “${debouncedQuery}”.`
                  : "No narrators match these filters."}
              </p>
            ) : intent === "listen" ? (
              <div className="grid gap-3">
                {filteredVoices.map((voice) => renderVoiceCard(voice, "listen"))}
              </div>
            ) : (
              <div className="space-y-8">
                {(grouped || []).map(([group, voices]) => (
                  <section key={group}>
                    <h2 className="text-sm uppercase tracking-wider text-muted-foreground mb-3 font-serif">
                      {group}
                    </h2>
                    <div className="grid gap-3">
                      {voices.map((voice) => renderVoiceCard(voice, "full"))}
                    </div>
                  </section>
                ))}
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
