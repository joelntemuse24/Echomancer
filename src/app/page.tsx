import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { Check, Star } from "lucide-react";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0d0d0d]">
      {/* Header */}
      <header className="border-b border-[#333]/50 backdrop-blur-sm sticky top-0 z-50 bg-[#0d0d0d]/90">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Logo size="md" />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link href="/dashboard">
              <Button variant="ghost" className="text-[#a39b8f] hover:text-[#faf9f7] hover:bg-[#242424]">Sign In</Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20 md:py-32">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <div className="space-y-4">
            <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold tracking-tight font-[family-name:var(--font-source-serif)] text-[#faf9f7]">
              Any PDF. Any voice. €4.
            </h1>
            <p className="text-xl md:text-2xl text-[#a39b8f] max-w-2xl mx-auto">
              Transform your documents into immersive audiobooks with custom voices from YouTube
            </p>
          </div>
          <Link href="/dashboard">
            <Button
              size="lg"
              className="bg-[#D97757] hover:bg-[#E8957A] text-[#0d0d0d] px-8 py-6 text-lg font-medium glow-copper"
            >
              Get Started
            </Button>
          </Link>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12 font-[family-name:var(--font-source-serif)] text-[#faf9f7]">
            Simple, Transparent Pricing
          </h2>
          <div className="grid md:grid-cols-2 gap-8">
            {/* One-Time Card */}
            <Card className="border-[#333] bg-[#1a1a1a] relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-[#D97757]/50 to-[#B85C3F]/50" />
              <CardHeader>
                <CardTitle className="text-2xl text-[#faf9f7]">One-Time</CardTitle>
                <CardDescription className="text-[#a39b8f]">Perfect for single audiobooks</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <div className="text-5xl font-bold text-[#faf9f7]">€4</div>
                  <p className="text-sm text-[#a39b8f]">per audiobook</p>
                </div>
                <ul className="space-y-3">
                  {["Single PDF conversion", "Any voice from YouTube", "High-quality audio output", "Download in MP3 format"].map((item) => (
                    <li key={item} className="flex items-start gap-2 text-[#faf9f7]">
                      <Check className="w-5 h-5 text-[#D97757] shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <Link href="/dashboard">
                  <Button variant="outline" className="w-full border-[#333] text-[#faf9f7] hover:bg-[#242424]">Get Started</Button>
                </Link>
              </CardContent>
            </Card>

            {/* Unlimited Card */}
            <Card className="border-[#D97757] bg-[#1a1a1a] relative overflow-hidden glow-copper">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-[#D97757] to-[#B85C3F]" />
              <Badge className="absolute top-4 right-4 bg-[#D97757] text-[#0d0d0d]">Most Popular</Badge>
              <CardHeader>
                <CardTitle className="text-2xl text-[#faf9f7]">Unlimited</CardTitle>
                <CardDescription className="text-[#a39b8f]">For avid readers and creators</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <div className="text-5xl font-bold text-[#faf9f7]">€15</div>
                  <p className="text-sm text-[#a39b8f]">per month</p>
                </div>
                <ul className="space-y-3">
                  {["Unlimited PDF conversions", "Any voice from YouTube", "Priority processing queue", "Advanced voice clipping tools", "Batch processing"].map((item) => (
                    <li key={item} className="flex items-start gap-2 text-[#faf9f7]">
                      <Check className="w-5 h-5 text-[#D97757] shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <Link href="/dashboard">
                  <Button className="w-full bg-[#D97757] hover:bg-[#E8957A] text-[#0d0d0d]">Start Free Trial</Button>
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12 font-[family-name:var(--font-source-serif)] text-[#faf9f7]">
            Loved by Readers Worldwide
          </h2>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              { name: "Sarah Mitchell", role: "PhD Student", content: "echomancer has transformed how I consume research papers. Being able to listen to PDFs in my favorite podcast host's voice makes studying so much more engaging." },
              { name: "James Chen", role: "Audiobook Enthusiast", content: "I've been using echomancer for public domain classics. The voice cloning quality is incredible, and at €4 per book, it's an absolute steal." },
              { name: "Maria Rodriguez", role: "Content Creator", content: "The unlimited plan is perfect for my workflow. I convert dozens of documents every week, and the voice customization options are unmatched." },
            ].map((t, i) => (
              <Card key={i} className="bg-[#1a1a1a] border-[#333]">
                <CardHeader>
                  <div className="flex gap-1 mb-2">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <Star key={j} className="w-4 h-4 fill-[#D97757] text-[#D97757]" />
                    ))}
                  </div>
                  <CardTitle className="text-lg text-[#faf9f7]">{t.name}</CardTitle>
                  <CardDescription className="text-[#a39b8f]">{t.role}</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-[#a39b8f]">{t.content}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#333]/50 mt-20">
        <div className="container mx-auto px-4 py-12">
          <div className="grid md:grid-cols-4 gap-8">
            <div className="space-y-4">
              <Logo size="sm" />
              <p className="text-sm text-[#a39b8f]">Transform PDFs into audiobooks with custom voices</p>
            </div>
            <div className="space-y-4">
              <h4 className="font-semibold text-[#faf9f7]">Product</h4>
              <ul className="space-y-2 text-sm text-[#a39b8f]">
                <li><a href="#" className="hover:text-[#faf9f7] transition-colors">Features</a></li>
                <li><a href="#" className="hover:text-[#faf9f7] transition-colors">Pricing</a></li>
                <li><a href="#" className="hover:text-[#faf9f7] transition-colors">FAQ</a></li>
              </ul>
            </div>
            <div className="space-y-4">
              <h4 className="font-semibold text-[#faf9f7]">Legal</h4>
              <ul className="space-y-2 text-sm text-[#a39b8f]">
                <li><a href="#" className="hover:text-[#faf9f7] transition-colors">Terms of Service</a></li>
                <li><a href="#" className="hover:text-[#faf9f7] transition-colors">Privacy Policy</a></li>
              </ul>
            </div>
            <div className="space-y-4">
              <h4 className="font-semibold text-[#faf9f7]">Support</h4>
              <ul className="space-y-2 text-sm text-[#a39b8f]">
                <li><a href="#" className="hover:text-[#faf9f7] transition-colors">Help Center</a></li>
                <li><a href="#" className="hover:text-[#faf9f7] transition-colors">Contact Us</a></li>
              </ul>
            </div>
          </div>
          <div className="mt-12 pt-8 border-t border-[#333]/50 text-center text-sm text-[#a39b8f]">
            &copy; {new Date().getFullYear()} echomancer. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}
