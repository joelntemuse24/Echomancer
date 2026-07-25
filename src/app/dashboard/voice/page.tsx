"use client";

import { Button } from "@/components/ui/button";
import {
  Loader2,
  ArrowLeft,
  Headphones,
  Download,
  Crown,
  Search,
  Sparkles,
  Play,
  Square,
} from "lucide-react";
import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { motion } from "motion/react";

type Tab = "browse" | "hd";

interface CatalogVoice {
  id: string;
  provider: string;
  providerVoiceId: string;
  displayName: string;
  language: string;
  locale: string;
  gender: string;
  style: string;
  tags: string[];
  model: string;
  latencyClass: string;
  qualityNotes?: string;
  priceEstimate?: {
    suggestedPriceEur: number;
    estimatedAudioHours: number;
    ttsCogsUsd: number;
    targetPriceEur: number;
  } | null;
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

  const [tab, setTab] = useState<Tab>("browse");
  const [voices, setVoices] = useState<CatalogVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(true);
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [vendors, setVendors] = useState<string[]>([]);
  const [catalogSource, setCatalogSource] = useState<string>("static");

  const [hdVoices, setHdVoices] = useState<CatalogVoice[]>([]);
  const [loadingHd, setLoadingHd] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (providerFilter !== "all") params.set("provider", providerFilter);
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    if (charCount > 0) params.set("charCount", String(charCount));
    setLoadingVoices(true);
    fetch(`/api/tts/voices?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        setVoices(data.voices || []);
        setVendors(data.vendors || []);
        setCatalogSource(data.source || "static");
      })
      .catch(() => toast.error("Failed to load voices"))
      .finally(() => setLoadingVoices(false));
  }, [providerFilter, debouncedQuery, charCount]);

  useEffect(() => {
    if (tab === "hd") {
      setLoadingHd(true);
      fetch(`/api/tts/voices?q=minimax`)
        .then((r) => r.json())
        .then((data) => setHdVoices(data.voices || []))
        .catch(() => toast.error("Failed to load HD voices"))
        .finally(() => setLoadingHd(false));
    }
  }, [tab]);

  const previewVoice = async (voice: CatalogVoice) => {
    // If already playing this voice, stop it
    if (previewingId === voice.id && previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
      setPreviewingId(null);
      return;
    }
    // Stop any existing preview
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
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
        throw new Error(data.error || "Preview failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => {
        setPreviewingId(null);
        URL.revokeObjectURL(url);
      };
      audio.onerror = () => {
        setPreviewingId(null);
        URL.revokeObjectURL(url);
      };
      previewAudioRef.current = audio;
      setPreviewingId(voice.id);
      await audio.play();
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
          voiceName: voice.displayName,
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
        toast.success("Starting live listen…");
        router.push(`/dashboard/player/${data.jobId}?mode=stream`);
      } else {
        toast.success(
          data.priceEstimate
            ? `Generating full book · est. €${data.priceEstimate.suggestedPriceEur.toFixed(2)}`
            : "Generating full audiobook…"
        );
        router.push(`/dashboard/queue`);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setCreating(null);
    }
  };

  return (
    <div className="max-w-3xl mx-auto pt-8 pb-16 px-4">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center space-y-3 mb-8"
      >
        <h1
          className="text-5xl md:text-6xl tracking-tight font-serif"
          style={{ fontWeight: 300 }}
        >
          Choose a narrator
        </h1>
        <p className="text-lg text-muted-foreground font-serif">
          Stock voices by default · HD premium voices available
        </p>
        <p className="text-xs text-muted-foreground">
          Target ~€4.50 for a typical book · price scales with length &amp; engine
          {catalogSource === "openrouter" && (
            <span className="block mt-1 text-[#D97757]">
              Live catalog via OpenRouter
            </span>
          )}
        </p>
      </motion.div>

      {pdfName && (
        <div className="flex justify-center mb-8">
          <button
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent border border-border/50 text-xs text-muted-foreground hover:border-border transition-colors"
            onClick={() => router.push("/")}
          >
            <ArrowLeft className="w-3 h-3" />
            <span className="max-w-[180px] truncate">{pdfName}</span>
          </button>
        </div>
      )}

      <div className="flex justify-center mb-8">
        <div className="inline-flex bg-accent border border-border/50 rounded-sm p-1 flex-wrap justify-center">
          {(
            [
              ["browse", "Browse"],
              ["hd", "HD Premium"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`px-5 py-2.5 text-sm uppercase tracking-wider rounded-sm transition-all inline-flex items-center gap-1.5 ${
                tab === key
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setTab(key)}
            >
              {key === "hd" && <Crown className="w-3.5 h-3.5" />}
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "browse" && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search voices, accents, styles…"
                className="w-full h-10 pl-9 pr-3 rounded-sm border border-border bg-background text-sm"
              />
            </div>
            <select
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              className="h-10 px-3 rounded-sm border border-border bg-background text-sm"
            >
              <option value="all">All providers</option>
              {vendors.length > 0 ? (
                vendors.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))
              ) : (
                <>
                  <option value="google">Google</option>
                  <option value="gemini">Gemini</option>
                  <option value="grok">Grok</option>
                  <option value="openrouter">OpenRouter</option>
                </>
              )}
            </select>
          </div>

          {loadingVoices ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : voices.length === 0 ? (
            <p className="text-center text-muted-foreground py-12">
              No voices match your filters.
            </p>
          ) : (
            <div className="grid gap-3">
              {voices.map((voice) => (
                <div
                  key={voice.id}
                  className="border border-border rounded-sm p-4 hover:border-foreground/25 transition-colors"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium font-serif text-lg">
                          {voice.displayName}
                        </h3>
                        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent text-muted-foreground">
                          {voice.provider}
                        </span>
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          {voice.locale} · {voice.gender}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {voice.style} · {voice.tags.slice(0, 4).join(" · ")}
                      </p>
                      {voice.qualityNotes && (
                        <p className="text-xs text-muted-foreground/80 mt-1">
                          {voice.qualityNotes}
                        </p>
                      )}
                      {voice.priceEstimate && (
                        <p className="text-xs mt-2 text-[#D97757]">
                          Est. take-home €
                          {voice.priceEstimate.suggestedPriceEur.toFixed(2)}
                          {" · "}
                          ~{voice.priceEstimate.estimatedAudioHours}h audio
                          {" · "}
                          target €{voice.priceEstimate.targetPriceEur.toFixed(2)}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!previewLoading && previewLoading !== voice.id}
                        onClick={() => previewVoice(voice)}
                        className="gap-1.5 px-2.5"
                        title="Preview voice"
                      >
                        {previewLoading === voice.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : previewingId === voice.id ? (
                          <Square className="w-3.5 h-3.5" />
                        ) : (
                          <Play className="w-3.5 h-3.5" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!creating}
                        onClick={() => createStockJob(voice, "stream")}
                        className="gap-1.5"
                      >
                        {creating === `${voice.id}-stream` ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Headphones className="w-3.5 h-3.5" />
                        )}
                        Listen
                      </Button>
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
                        Full book
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}

      {tab === "hd" && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
          <div className="mb-6 p-4 border border-[#D97757]/40 bg-[#D97757]/5 rounded-sm">
            <div className="flex items-center gap-2 text-sm font-medium mb-1">
              <Sparkles className="w-4 h-4 text-[#D97757]" />
              Premium HD Voices · Minimax & others
            </div>
            <p className="text-xs text-muted-foreground">
              Studio-quality narration via Minimax Speech-02 HD and similar models on OpenRouter.
              Priced per character — estimate shown for your book.
            </p>
          </div>

          {loadingHd ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : hdVoices.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-border/50 rounded-sm">
              <Crown className="w-8 h-8 mx-auto mb-3 text-muted-foreground/50" />
              <p className="text-muted-foreground">No HD voices available.</p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Set OPENROUTER_API_KEY to load Minimax and other HD models.
              </p>
            </div>
          ) : (
            <div className="grid gap-3">
              {hdVoices.map((voice) => (
                <div
                  key={voice.id}
                  className="border border-[#D97757]/30 rounded-sm p-4 hover:border-[#D97757]/60 transition-colors bg-[#D97757]/5"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium font-serif text-lg">
                          {voice.displayName}
                        </h3>
                        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-[#D97757]/20 text-[#D97757]">
                          HD
                        </span>
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          {voice.locale} · {voice.gender}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {voice.style} · {voice.tags.slice(0, 4).join(" · ")}
                      </p>
                      {voice.qualityNotes && (
                        <p className="text-xs text-muted-foreground/80 mt-1">
                          {voice.qualityNotes}
                        </p>
                      )}
                      {voice.priceEstimate && (
                        <p className="text-xs mt-2 text-[#D97757] font-medium">
                          Est. take-home €{voice.priceEstimate.suggestedPriceEur.toFixed(2)}
                          {" · "}
                          ~{voice.priceEstimate.estimatedAudioHours}h audio
                          {" · "}
                          COGS ${voice.priceEstimate.ttsCogsUsd.toFixed(2)}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!previewLoading && previewLoading !== voice.id}
                        onClick={() => previewVoice(voice)}
                        className="gap-1.5 px-2.5"
                        title="Preview voice"
                      >
                        {previewLoading === voice.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : previewingId === voice.id ? (
                          <Square className="w-3.5 h-3.5" />
                        ) : (
                          <Play className="w-3.5 h-3.5" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!creating}
                        onClick={() => createStockJob(voice, "stream")}
                        className="gap-1.5"
                      >
                        {creating === `${voice.id}-stream` ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Headphones className="w-3.5 h-3.5" />
                        )}
                        Listen
                      </Button>
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
                        Full book
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}

      <div className="flex items-center justify-center gap-2 mt-10">
        <span className="w-1.5 h-1.5 rounded-full bg-[#7a8f7e]" />
        <span className="w-1.5 h-1.5 rounded-full bg-[#D97757]" />
        <span className="w-1.5 h-1.5 rounded-full bg-[#2a2a2a]" />
      </div>
    </div>
  );
}
