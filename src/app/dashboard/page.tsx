"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileText, CheckCircle2, Loader2 } from "lucide-react";
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export default function PDFUploadPage() {
  const router = useRouter();
  const [isDragging, setIsDragging] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    const pdfFile = files.find((file) => file.type === "application/pdf");
    if (pdfFile) {
      setUploadedFile(pdfFile);
    }
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files[0]) {
      const file = files[0];
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        setUploadedFile(file);
      } else {
        toast.error("Please select a PDF file");
        e.target.value = "";
      }
    }
  }, []);

  const handleContinue = async () => {
    if (!uploadedFile || isUploading) return;

    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append("file", uploadedFile);

      const res = await fetch("/api/pdf/upload", { method: "POST", body: formData });
      const data = await res.json();

      console.log("Upload response:", res.status, data);

      if (!res.ok) {
        throw new Error(data.error || "Upload failed");
      }

      toast.success("PDF uploaded successfully!");
      const navUrl = `/dashboard/voice?pdfPath=${encodeURIComponent(data.storagePath)}&pdfName=${encodeURIComponent(uploadedFile.name)}`;
      console.log("Navigating to:", navUrl);
      router.push(navUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Upload failed";
      console.error("Upload/navigation error:", error);
      toast.error(message);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold font-[family-name:var(--font-source-serif)] text-[#faf9f7]">Upload Your PDF</h1>
        <p className="text-[#a39b8f]">
          Select a PDF document to convert into an audiobook
        </p>
      </div>

      {/* Drag and Drop Zone */}
      <Card
        className={`transition-all duration-300 border-2 ${
          isDragging
            ? "border-[#D97757] bg-[#D97757]/5 glow-copper"
            : uploadedFile
            ? "border-[#7a8f7e] bg-[#7a8f7e]/5"
            : "border-dashed border-[#333] hover:border-[#D97757]/50"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <CardContent className="p-12">
          <div className="flex flex-col items-center justify-center space-y-6 text-center">
            {uploadedFile ? (
              <>
                <div className="w-16 h-16 rounded-full bg-[#7a8f7e]/10 flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-[#7a8f7e]" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold font-[family-name:var(--font-source-serif)] text-[#faf9f7]">File Ready</h3>
                  <p className="text-[#a39b8f]">{uploadedFile.name}</p>
                  <p className="text-sm text-[#a39b8f]">
                    {(uploadedFile.size / (1024 * 1024)).toFixed(2)} MB
                  </p>
                </div>
                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setUploadedFile(null)}>
                    Change File
                  </Button>
                  <Button
                    className="bg-[#D97757] hover:bg-[#E8957A] text-[#0d0d0d]"
                    onClick={handleContinue}
                    disabled={isUploading}
                  >
                    {isUploading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      "Continue to Voice Selection"
                    )}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-colors ${isDragging ? "bg-[#D97757]/20" : "bg-[#242424]"}`}>
                  <Upload className={`w-8 h-8 ${isDragging ? "text-[#D97757]" : "text-[#a39b8f]"}`} />
                </div>
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold font-[family-name:var(--font-source-serif)] text-[#faf9f7]">{isDragging ? "Drop your PDF here" : "Drag & drop your PDF"}</h3>
                  <p className="text-[#a39b8f]">or click to browse your files</p>
                </div>
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  onChange={handleFileInput}
                  className="hidden"
                  id="pdf-upload"
                />
                <label htmlFor="pdf-upload">
                  <Button variant="outline" asChild>
                    <span>Browse Files</span>
                  </Button>
                </label>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Supported Formats */}
      <Card className="bg-[#1a1a1a] border-[#333]">
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <FileText className="w-6 h-6 text-[#D97757] shrink-0 mt-1" />
            <div className="space-y-2">
              <h4 className="font-semibold font-[family-name:var(--font-source-serif)] text-[#faf9f7]">Supported Formats</h4>
              <ul className="text-sm text-[#a39b8f] space-y-1">
                <li>— PDF documents (.pdf)</li>
                <li>— Maximum file size: 100 MB</li>
                <li>— Text-based PDFs work best</li>
                <li>— Scanned documents may require OCR preprocessing</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tips */}
      <Card className="bg-[#1a1a1a] border-[#333]">
        <CardContent className="p-6">
          <div className="space-y-4">
            <h4 className="font-semibold font-[family-name:var(--font-source-serif)] text-[#faf9f7]">Tips for Best Results</h4>
            <ul className="text-sm text-[#a39b8f] space-y-2">
              <li>— Use high-quality PDFs with clear, readable text</li>
              <li>— Remove unnecessary pages (covers, blank pages) for faster processing</li>
              <li>— Ensure the PDF is not password-protected</li>
              <li>— For academic papers, consider splitting into chapters</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
