"use client";

import { FileText, Mic, BookOpen } from "lucide-react";

export default function ResourcesPage() {
  const resources = [
    {
      icon: FileText,
      title: "Best formats",
      description: "EPUB or clean TXT are ideal. PDF works too — we extract and normalize text at upload."
    },
    {
      icon: Mic,
      title: "Choosing a narrator",
      description: "Preview voices before you commit. Use Listen for a live sample, or Full book for an offline copy."
    },
    {
      icon: BookOpen,
      title: "How it works",
      description: "Upload a book → pick a narrator → Listen live or generate a full take-home audiobook to download."
    },
  ];

  const faqs = [
    { q: "How long does a full book take?", a: "Usually a few minutes for short books; longer titles generate section by section so you can listen early." },
    { q: "What's the live listen limit?", a: "Live sessions continue in short chunks with a overall listening budget. Generate a full take-home copy for the whole book." },
    { q: "What voices are available?", a: "Narrators via OpenRouter — Google, Gemini, Grok, OpenAI, and premium HD models like Minimax when enabled." },
  ];

  return (
    <div className="max-w-2xl mx-auto pt-8">
      {/* Header */}
      <div className="text-center space-y-1 mb-8">
        <h1 className="text-xl font-medium text-foreground">Resources</h1>
      </div>

      {/* Resources */}
      <div className="space-y-3 mb-8">
        {resources.map((resource) => (
          <div 
            key={resource.title}
            className="flex items-start gap-4 p-4 rounded-xl border border-border/50 bg-card"
          >
            <div className="w-10 h-10 rounded-full bg-accent flex items-center justify-center shrink-0">
              <resource.icon className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-medium text-foreground">{resource.title}</h3>
              <p className="text-xs text-muted-foreground mt-1">{resource.description}</p>
            </div>
          </div>
        ))}
      </div>

      {/* FAQ */}
      <div className="space-y-1">
        <h2 className="text-sm font-medium text-muted-foreground mb-4">FAQ</h2>
        {faqs.map((faq, i) => (
          <div 
            key={i} 
            className="p-4 rounded-xl border border-border/50 bg-card"
          >
            <p className="text-sm text-foreground">{faq.q}</p>
            <p className="text-xs text-muted-foreground mt-1">{faq.a}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
