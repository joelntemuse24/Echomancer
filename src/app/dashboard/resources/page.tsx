"use client";

import { UX } from "@/lib/ux-copy";

export default function ResourcesPage() {
  const sections = [
    {
      title: "Path",
      body: "Upload or paste. Standard or Clone. Preview or Make audiobook.",
    },
    {
      title: "Formats",
      body: "EPUB or TXT preferred. PDF, DOCX, RTF, and MOBI also work.",
    },
    {
      title: "Standard",
      body: "Standard, Michelle, Clara, and Randolph.",
    },
    {
      title: "Clone",
      body: `12 seconds to 3 minutes, phone close. ${UX.cloneSampleTip}`,
    },
    {
      title: UX.preview,
      body: UX.tryChapterBlurb,
    },
    {
      title: UX.makeAudiobook,
      body: UX.wholeBookBlurb,
    },
    {
      title: UX.narrationDelivery,
      body: UX.narrationDeliveryHint,
    },
    {
      title: "Time",
      body: "Short books often finish in a minute or two. Longer titles generate section by section — you can listen to ready sections before the whole book is done.",
    },
  ];

  return (
    <div className="max-w-2xl mx-auto pt-8 pb-12 px-4">
      <h1
        className="text-5xl tracking-tight font-serif text-center mb-10"
        style={{ fontWeight: 300 }}
      >
        {UX.howItWorks}
      </h1>

      <div className="space-y-3">
        {sections.map((section) => (
          <div
            key={section.title}
            className="p-5 rounded-sm border border-border/50 bg-card"
          >
            <h2 className="text-base font-serif text-foreground">{section.title}</h2>
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
              {section.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
