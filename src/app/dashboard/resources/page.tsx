"use client";

import { FileText, Mic, BookOpen } from "lucide-react";
import { UX } from "@/lib/ux-copy";

export default function ResourcesPage() {
  const resources = [
    {
      icon: FileText,
      title: "Best formats",
      description:
        "EPUB or clean TXT are ideal. PDF works too — we extract and normalize text at upload.",
    },
    {
      icon: Mic,
      title: "Choosing a narrator",
      description: `Preview a short line, then ${UX.tryChapter.toLowerCase()} for about an hour of listening, or ${UX.wholeBook.toLowerCase()} for a downloadable copy.`,
    },
    {
      icon: BookOpen,
      title: "How it works",
      description: `Upload a book → pick a narrator → ${UX.tryChapter.toLowerCase()} or ${UX.wholeBook.toLowerCase()} to download.`,
    },
  ];

  const faqs = [
    {
      q: "How long does a full book take?",
      a: "Short books usually finish in under a minute or two. Longer titles generate section by section, so you can often start listening before the whole book is ready.",
    },
    {
      q: "What's the chapter listening limit?",
      a: "Trying a chapter gives you about an hour of listening in short sessions. Save the full audiobook when you want the complete offline copy.",
    },
    {
      q: "What voices are available?",
      a: "Curated narrators via OpenRouter — Gemini (with accent variants), Qwen, Microsoft, Grok, and Minimax HD when enabled.",
    },
  ];

  return (
    <div className="max-w-2xl mx-auto pt-8 pb-12 px-4">
      <div className="text-center space-y-2 mb-10">
        <h1
          className="text-5xl tracking-tight font-serif"
          style={{ fontWeight: 300 }}
        >
          Resources
        </h1>
        <p className="text-muted-foreground font-serif">
          A little guidance so everything feels clear.
        </p>
      </div>

      <div className="space-y-3 mb-10">
        {resources.map((resource) => (
          <div
            key={resource.title}
            className="flex items-start gap-4 p-5 rounded-sm border border-border/50 bg-card"
          >
            <div className="w-10 h-10 rounded-sm bg-accent flex items-center justify-center shrink-0">
              <resource.icon className="w-4 h-4 text-[#D97757]" />
            </div>
            <div>
              <h3 className="text-base font-serif text-foreground">
                {resource.title}
              </h3>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                {resource.description}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-1">
        <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-4 font-serif">
          FAQ
        </h2>
        {faqs.map((faq) => (
          <div
            key={faq.q}
            className="p-5 rounded-sm border border-border/50 bg-card mb-3"
          >
            <p className="text-sm font-medium text-foreground font-serif">
              {faq.q}
            </p>
            <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
              {faq.a}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
