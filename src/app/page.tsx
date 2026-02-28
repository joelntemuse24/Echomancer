import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Check, Star } from "lucide-react";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 backdrop-blur-sm sticky top-0 z-50 bg-background/80">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Logo size="md" />
          <Link href="/dashboard">
            <Button variant="ghost">Sign In</Button>
          </Link>
        </div>
      </header>

      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20 md:py-32">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <div className="space-y-4">
            <h1 className="text-4xl md:text-6xl lg:text-7xl font-bold tracking-tight">
              Any PDF. Any voice. €4.
            </h1>
            <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mx-auto">
              Transform your documents into immersive audiobooks with custom voices from YouTube
            </p>
          </div>
          <Link href="/dashboard">
            <Button
              size="lg"
              className="bg-primary hover:bg-primary/90 text-primary-foreground px-8 py-6 text-lg glow-purple"
            >
              Get Started
            </Button>
          </Link>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12">
            Simple, Transparent Pricing
          </h2>
          <div className="grid md:grid-cols-2 gap-8">
            {/* One-Time Card */}
            <Card className="border-border bg-card relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500/50 to-pink-500/50" />
              <CardHeader>
                <CardTitle className="text-2xl">One-Time</CardTitle>
                <CardDescription>Perfect for single audiobooks</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <div className="text-5xl font-bold">€4</div>
                  <p className="text-sm text-muted-foreground">per audiobook</p>
                </div>
                <ul className="space-y-3">
                  {["Single PDF conversion", "Any voice from YouTube", "High-quality audio output", "Download in MP3 format"].map((item) => (
                    <li key={item} className="flex items-start gap-2">
                      <Check className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <Link href="/dashboard">
                  <Button variant="outline" className="w-full">Get Started</Button>
                </Link>
              </CardContent>
            </Card>

            {/* Unlimited Card */}
            <Card className="border-primary bg-card relative overflow-hidden glow-purple">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500 to-pink-500" />
              <Badge className="absolute top-4 right-4 bg-primary text-primary-foreground">Most Popular</Badge>
              <CardHeader>
                <CardTitle className="text-2xl">Unlimited</CardTitle>
                <CardDescription>For avid readers and creators</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <div className="text-5xl font-bold">€15</div>
                  <p className="text-sm text-muted-foreground">per month</p>
                </div>
                <ul className="space-y-3">
                  {["Unlimited PDF conversions", "Any voice from YouTube", "Priority processing queue", "Advanced voice clipping tools", "Batch processing"].map((item) => (
                    <li key={item} className="flex items-start gap-2">
                      <Check className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <Link href="/dashboard">
                  <Button className="w-full bg-primary hover:bg-primary/90 text-primary-foreground">Start Free Trial</Button>
                </Link>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12">
            Loved by Readers Worldwide
          </h2>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              { name: "Sarah Mitchell", role: "PhD Student", content: "echomancer has transformed how I consume research papers. Being able to listen to PDFs in my favorite podcast host's voice makes studying so much more engaging." },
              { name: "James Chen", role: "Audiobook Enthusiast", content: "I've been using echomancer for public domain classics. The voice cloning quality is incredible, and at €4 per book, it's an absolute steal." },
              { name: "Maria Rodriguez", role: "Content Creator", content: "The unlimited plan is perfect for my workflow. I convert dozens of documents every week, and the voice customization options are unmatched." },
            ].map((t, i) => (
              <Card key={i} className="bg-card border-border">
                <CardHeader>
                  <div className="flex gap-1 mb-2">
                    {Array.from({ length: 5 }).map((_, j) => (
                      <Star key={j} className="w-4 h-4 fill-primary text-primary" />
                    ))}
                  </div>
                  <CardTitle className="text-lg">{t.name}</CardTitle>
                  <CardDescription>{t.role}</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{t.content}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/50 mt-20">
        <div className="container mx-auto px-4 py-12">
          <div className="grid md:grid-cols-4 gap-8">
            <div className="space-y-4">
              <Logo size="sm" />
              <p className="text-sm text-muted-foreground">Transform PDFs into audiobooks with custom voices</p>
            </div>
            <div className="space-y-4">
              <h4 className="font-semibold">Product</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><a href="#" className="hover:text-foreground transition-colors">Features</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">Pricing</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">FAQ</a></li>
              </ul>
            </div>
            <div className="space-y-4">
              <h4 className="font-semibold">Legal</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><a href="#" className="hover:text-foreground transition-colors">Terms of Service</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">Privacy Policy</a></li>
              </ul>
            </div>
            <div className="space-y-4">
              <h4 className="font-semibold">Support</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li><a href="#" className="hover:text-foreground transition-colors">Help Center</a></li>
                <li><a href="#" className="hover:text-foreground transition-colors">Contact Us</a></li>
              </ul>
            </div>
          </div>
          <div className="mt-12 pt-8 border-t border-border/50 text-center text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} echomancer. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}
