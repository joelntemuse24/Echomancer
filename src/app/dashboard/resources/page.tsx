"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BookOpen, FileText, Mic, HelpCircle } from "lucide-react";

export default function ResourcesPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Resources</h1>
        <p className="text-muted-foreground">Guides and tips for getting the most out of Echomancer</p>
      </div>

      <div className="grid gap-6">
        <Card className="bg-card border-border">
          <CardHeader>
            <div className="flex items-center gap-3">
              <FileText className="w-6 h-6 text-primary" />
              <CardTitle>PDF Preparation Guide</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>For best results with your audiobook conversions:</p>
            <ul className="space-y-2 ml-4">
              <li>- Use text-based PDFs (not scanned images)</li>
              <li>- Remove table of contents, indexes, and bibliography pages</li>
              <li>- Split very large documents (&gt;500 pages) into chapters</li>
              <li>- Ensure the PDF is not password-protected</li>
            </ul>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Mic className="w-6 h-6 text-primary" />
              <CardTitle>Voice Selection Tips</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>Choose the right voice for your audiobook:</p>
            <ul className="space-y-2 ml-4">
              <li>- Look for clear, solo-speaker audio (podcasts, narrations, lectures)</li>
              <li>- Avoid background music or multiple speakers</li>
              <li>- A 10-30 second clip is ideal for voice cloning</li>
              <li>- Higher quality audio samples produce better results</li>
            </ul>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader>
            <div className="flex items-center gap-3">
              <BookOpen className="w-6 h-6 text-primary" />
              <CardTitle>How It Works</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <ol className="space-y-2 ml-4 list-decimal list-inside">
              <li>Upload your PDF document</li>
              <li>Search YouTube for a voice you like, or upload your own audio sample</li>
              <li>Select a clip of the voice to use for cloning</li>
              <li>Our AI generates the audiobook using the cloned voice</li>
              <li>Download or stream your finished audiobook</li>
            </ol>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader>
            <div className="flex items-center gap-3">
              <HelpCircle className="w-6 h-6 text-primary" />
              <CardTitle>FAQ</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {[
              { q: "How long does audiobook generation take?", a: "Typically 5-15 minutes depending on document length. You'll see real-time progress updates on the Queue page." },
              { q: "What voice models are used?", a: "We use F5-TTS, one of the best open-source voice cloning models, running on cloud infrastructure via Replicate." },
              { q: "Is there a page limit?", a: "No hard page limit, but very large documents (500+ pages) may take longer to process." },
              { q: "Can I reuse a cloned voice?", a: "Saved voices will be available in a future update. For now, you can re-upload the same audio sample." },
            ].map((faq, i) => (
              <div key={i} className="space-y-1">
                <p className="font-medium text-foreground">{faq.q}</p>
                <p className="text-muted-foreground">{faq.a}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
