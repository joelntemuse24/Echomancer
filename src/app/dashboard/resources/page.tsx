"use client";

import { FileText, Mic, BookOpen } from "lucide-react";

export default function ResourcesPage() {
  const resources = [
    {
      icon: FileText,
      title: "PDF Guide",
      description: "Use text-based PDFs. We auto-remove headers and page numbers."
    },
    {
      icon: Mic,
      title: "Voice Tips",
      description: "Clear, solo speech works best. 15-30 seconds ideal."
    },
    {
      icon: BookOpen,
      title: "How it works",
      description: "Upload PDF → Choose voice → AI generates → Download audiobook."
    },
  ];

  const faqs = [
    { q: "How long does it take?", a: "5-15 minutes depending on length." },
    { q: "What's the voice model?", a: "MOSS-TTS with zero-shot voice cloning." },
    { q: "Page limit?", a: "No hard limit, but 500+ pages takes longer." },
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
