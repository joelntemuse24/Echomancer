"use client";

import { useState, useRef } from 'react';
import { motion } from 'motion/react';
import { Upload, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { warmupModal } from '@/lib/modal-client';

export default function LandingPage() {
  const router = useRouter();
  const [bookFile, setBookFile] = useState<File | null>(null);
  const [isDraggingBook, setIsDraggingBook] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const dragCounter = useRef(0);

  const handleBookDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDraggingBook(false);
    const file = e.dataTransfer.files[0];
    const validExts = ['.pdf', '.epub', '.docx', '.doc', '.txt', '.text', '.rtf', '.mobi', '.azw', '.azw3', '.azw4'];
    if (file && validExts.some(ext => file.name.toLowerCase().endsWith(ext))) setBookFile(file);
  };

  const handleSubmit = async () => {
    if (!bookFile) {
      toast.error('Please select a document first');
      return;
    }
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', bookFile);
      const res = await fetch('/api/pdf/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      // Pre-warm GPU containers while user navigates to voice selection
      warmupModal();
      router.push(
        `/dashboard/voice?pdfPath=${encodeURIComponent(data.storagePath)}&pdfName=${encodeURIComponent(data.fileName)}`
      );
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current += 1;
    setIsDraggingBook(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) {
      setIsDraggingBook(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-serif">
      {/* Navigation */}
      <motion.nav
        className="fixed top-0 left-0 right-0 z-50 px-8 py-6 flex justify-between items-center border-b border-border/50 bg-background/80 backdrop-blur-sm"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
      >
        <div className="text-sm tracking-[0.2em] uppercase font-serif">
          Echomancer
        </div>
        <div className="flex gap-8 text-sm text-muted-foreground">
          <button
            onClick={() => router.push('/dashboard/queue')}
            className="hover:text-foreground transition-colors"
          >
            Library
          </button>
        </div>
      </motion.nav>

      {/* Hero Section */}
      <section className="relative min-h-screen flex items-center justify-center px-8">
        <div className="max-w-4xl mx-auto text-center space-y-12">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.2 }}
          >
            <h1
              className="text-8xl md:text-9xl tracking-tight mb-6"
              style={{
                fontWeight: 300,
                letterSpacing: '-0.02em'
              }}
            >
              Echomancer
            </h1>
            <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mx-auto leading-relaxed font-serif">
              Transform any book into an audiobook. Your voice, the author's voice, or anyone's voice from history.
            </p>
          </motion.div>

          {/* Upload Interface */}
          <motion.div
            className="max-w-md mx-auto"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.5 }}
          >
            <div
              onDrop={handleBookDrop}
              onDragOver={(e) => e.preventDefault()}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              className={`relative border border-border rounded-sm p-12 transition-all cursor-pointer group hover:border-foreground/30 ${
                isDraggingBook ? 'border-foreground/50 bg-accent' : ''
              }`}
            >
              <input
                type="file"
                accept=".pdf,.epub,.docx,.doc,.txt,.text,.rtf,.mobi,.azw,.azw3,.azw4"
                onChange={(e) => setBookFile(e.target.files?.[0] || null)}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
              <div className="text-center space-y-4">
                <Upload className="w-8 h-8 mx-auto text-muted-foreground group-hover:text-foreground transition-colors" />
                <div>
                  <div className="text-sm uppercase tracking-wider mb-2 font-serif">
                    {bookFile ? bookFile.name : 'Your Book'}
                  </div>
                  <div className="text-xs text-muted-foreground">PDF, EPUB, DOCX, TXT, RTF, MOBI</div>
                </div>
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 0.8 }}
          >
            <button
              onClick={handleSubmit}
              disabled={isUploading || !bookFile}
              className="px-8 py-4 bg-foreground text-background uppercase tracking-wider text-sm hover:bg-foreground/90 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {isUploading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Uploading...
                </span>
              ) : (
                'Begin Transformation'
              )}
            </button>
          </motion.div>
        </div>

        {/* Scroll Indicator */}
        <motion.div
          className="absolute bottom-12 left-1/2 -translate-x-1/2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 1.2 }}
        >
          <div className="w-px h-16 bg-gradient-to-b from-transparent via-border to-transparent" />
        </motion.div>
      </section>

      {/* Possibilities Section */}
      <section className="py-32 px-8 border-t border-border/50">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 1 }}
            className="grid md:grid-cols-3 gap-16"
          >
            <div className="space-y-4">
              <div className="text-sm uppercase tracking-wider text-muted-foreground">Your Voice</div>
              <p className="text-lg leading-relaxed font-serif">
                Record a few minutes of yourself reading. Hear your favorite books in your own voice, forever.
              </p>
            </div>
            <div className="space-y-4">
              <div className="text-sm uppercase tracking-wider text-muted-foreground">Historic Voices</div>
              <p className="text-lg leading-relaxed font-serif">
                Use archived interviews, speeches, recordings. Imagine Hemingway reading Hemingway, or hearing philosophy in the voice of its author.
              </p>
            </div>
            <div className="space-y-4">
              <div className="text-sm uppercase tracking-wider text-muted-foreground">Anyone's Voice</div>
              <p className="text-lg leading-relaxed font-serif">
                A beloved teacher, a family member, a narrator you admire. The choice is yours.
              </p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Philosophy Section */}
      <section className="py-32 px-8 border-t border-border/50">
        <div className="max-w-3xl mx-auto text-center space-y-8">
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 1 }}
          >
            <h2 className="text-5xl md:text-6xl mb-8 font-serif" style={{ fontWeight: 300 }}>
              A space for immersion
            </h2>
            <p className="text-xl text-muted-foreground leading-relaxed font-serif">
              Books expand minds. Voice carries meaning. Together, they create experiences that transcend the page.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-16 px-8 border-t border-border/50">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between items-center gap-8 text-sm text-muted-foreground">
          <div className="tracking-[0.2em] uppercase font-serif">Echomancer</div>
          <div className="flex gap-8">
            <a href="#" className="hover:text-foreground transition-colors">Privacy</a>
            <a href="#" className="hover:text-foreground transition-colors">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
