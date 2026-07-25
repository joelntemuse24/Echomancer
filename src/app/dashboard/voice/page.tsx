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
import { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { motion } from "motion/react";

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

const VENDOR_LABELS: Record<string, string> = {
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  minimax: "Minimax HD",
  kokoro: "Kokoro",
  mistralai: "Mistral",
  microsoft: "Microsoft",
  deepgram: "Deepgram",
  elevenlabs: "ElevenLabs",
};

function vendorOf(voice: CatalogVoice): string {
  return voice.model.split("/")[0] || voice.provider;
}

function vendorLabel(vendor: string): string {
  return VENDOR_LABELS[vendor] || vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

function isHdVendor(vendor: string): boolean {
  return vendor === "minimax";
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
  const [activeVendor, setActiveVendor] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [catalogSource, setCatalogSource] = useState<string>("static");
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Fetch all voices once
  useEffect(() => {
    const params = new URLSearchParams();
    if (charCount > 0) params.set("charCount", String(charCount));
    fetch(`/api/tts/voices?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        setAllVoices(data.voices || []);
        setCatalogSource(data.source || "static");
        // Auto-select first vendor tab if available
        const vendors = Array.from(
          new Set((data.voices || []).map((v: CatalogVoice) => vendorOf(v)))
        ) as string[];
        vendors.sort();
        if (vendors.length > 0 && vendors[0]) setActiveVendor(vendors[0]);
      })
      .catch(() => toast.error("Failed to load voices"))
      .finally(() => setLoading(false));
  }, [charCount]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Group voices by vendor
  const vendorGroups = useMemo(() => {
    const groups: Record<string, CatalogVoice[]> = {};
    for (const v of allVoices) {
      const vendor = vendorOf(v);
      if (!groups[vendor]) groups[vendor] = [];
      groups[vendor].push(v);
    }
    return groups;
  }, [allVoices]);

  const sortedVendors = useMemo(
    () => Object.keys(vendorGroups).sort((a, b) => {
      // Minimax HD first, then alphabetical
      if (a === "minimax") return -1;
      if (b === "minimax") return 1;
      return vendorLabel(a).localeCompare(vendorLabel(b));
    }),
    [vendorGroups]
  );

  // Filter voices by active vendor + search
  const filteredVoices = useMemo(() => {
    let result = vendorGroups[activeVendor] || [];
    if (debouncedQuery.trim()) {
      const q = debouncedQuery.toLowerCase();
      result = result.filter(
        (v) =>
          v.displayName.toLowerCase().includes(q) ||
          v.providerVoiceId.toLowerCase().includes(q) ||
          v.locale.toLowerCase().includes(q) ||
          v.gender.toLowerCase().includes(q) ||
          v.style.toLowerCase().includes(q) ||
          (v.qualityNotes?.toLowerCase().includes(q) ?? false)
      );
    }
    return result;
  }, [vendorGroups, activeVendor, debouncedQuery]);

  const previewVoice = async (voice: CatalogVoice) => {
    if (previewingId === voice.id && previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
      setPreviewingId(null);
      return;
    }
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

  const hd = isHdVendor(activeVendor);

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
          Browse voices by provider · HD premium available
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

      {/* Provider tabs */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : sortedVendors.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-border/50 rounded-sm">
          <p className="text-muted-foreground">No voices available.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Set OPENROUTER_API_KEY to load the live voice catalog.
          </p>
        </div>
      ) : (
        <>
          <div className="flex gap-1 mb-6 overflow-x-auto pb-2 -mx-4 px-4 scrollbar-hide">
            {sortedVendors.map((vendor) => {
              const isHd = isHdVendor(vendor);
              const count = vendorGroups[vendor]?.length || 0;
              return (
                <button
                  key={vendor}
                  onClick={() => { setActiveVendor(vendor); setQuery(""); }}
                  className={`shrink-0 px-4 py-2 text-sm rounded-full border transition-all inline-flex items-center gap-1.5 ${
                    activeVendor === vendor
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                  }`}
                >
                  {isHd && <Crown className="w-3.5 h-3.5" />}
                  {vendorLabel(vendor)}
                  <span className={`text-[10px] ${activeVendor === vendor ? "text-background/60" : "text-muted-foreground/60"}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search within provider */}
          <div className="relative mb-6">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${vendorLabel(activeVendor)} voices…`}
              className="w-full h-10 pl-9 pr-3 rounded-sm border border-border bg-background text-sm"
            />
          </div>

          {/* HD banner */}
          {hd && (
            <div className="mb-4 p-3 border border-[#D97757]/40 bg-[#D97757]/5 rounded-sm">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="w-4 h-4 text-[#D97757]" />
                Premium HD · Studio-quality narration
              </div>
            </div>
          )}

          {/* Voice cards */}
          <motion.div
            key={activeVendor}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {filteredVoices.length === 0 ? (
              <p className="text-center text-muted-foreground py-12">
                No voices match &quot;{debouncedQuery}&quot; in {vendorLabel(activeVendor)}.
              </p>
            ) : (
              <div className="grid gap-3">
                {filteredVoices.map((voice) => (
                  <div
                    key={voice.id}
                    className={`border rounded-sm p-4 hover:border-foreground/25 transition-colors ${
                      hd
                        ? "border-[#D97757]/30 bg-[#D97757]/5 hover:border-[#D97757]/60"
                        : "border-border"
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-medium font-serif text-lg">
                            {voice.displayName}
                          </h3>
                          {hd && (
                            <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-[#D97757]/20 text-[#D97757]">
                              HD
                            </span>
                          )}
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
                          <p className={`text-xs mt-2 ${hd ? "text-[#D97757] font-medium" : "text-[#D97757]"}`}>
                            Est. take-home €{voice.priceEstimate.suggestedPriceEur.toFixed(2)}
                            {" · "}
                            ~{voice.priceEstimate.estimatedAudioHours}h audio
                            {hd && (
                              <>
                                {" · "}
                                COGS ${voice.priceEstimate.ttsCogsUsd.toFixed(2)}
                              </>
                            )}
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
