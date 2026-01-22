import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Upload, FileText, CheckCircle2, Loader2 } from "lucide-react";
import { useState, useCallback } from "react";
import { pdfApi } from "../lib/api";
import { extractTextFromPDF } from "../lib/pdfExtractor";
import { toast } from "sonner";

interface PDFUploadPageProps {
  onFileUploaded: (file: File, pdfUrl: string) => void;
}

export function PDFUploadPage({ onFileUploaded }: PDFUploadPageProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

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
    const pdfFile = files.find(file => file.type === "application/pdf");

    if (pdfFile) {
      setUploadedFile(pdfFile);
    }
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files[0]) {
      const file = files[0];
      // Validate it's a PDF
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith('.pdf')) {
        setUploadedFile(file);
      } else {
        toast.error('Please select a PDF file');
        // Reset the input
        e.target.value = '';
      }
    }
  }, []);

  const handleContinue = async () => {
    if (!uploadedFile) {
      toast.error('Please select a PDF file first');
      return;
    }

    if (isUploading) {
      return; // Already processing
    }

    setIsUploading(true);
    
    // Create local URL immediately for fallback
    const localUrl = URL.createObjectURL(uploadedFile);
    let pdfUrl = localUrl;

    // Try to extract text preview (completely non-blocking, fire and forget)
    extractTextFromPDF(uploadedFile).catch(() => {
      // Silently fail - extraction is optional
    });

    // Try to upload PDF to backend (non-blocking, with timeout)
    const uploadPromise = pdfApi.upload(uploadedFile)
      .then((result) => {
        // Handle local file URLs (when Bunny.net not configured)
        if (result.pdfUrl && result.pdfUrl.startsWith('local://')) {
          pdfUrl = localUrl;
          toast.info('PDF processed (using local file - CDN not configured)');
        } else {
          pdfUrl = result.pdfUrl || localUrl;
          toast.success('PDF uploaded successfully!');
        }
      })
      .catch((uploadError: any) => {
        console.warn('Backend upload failed, using local file:', uploadError);
        pdfUrl = localUrl;
        if (uploadError.code === 'ECONNABORTED' || uploadError.message?.includes('timeout')) {
          toast.info('Backend timeout - using local file');
        } else if (uploadError.response) {
          const errorMsg = uploadError.response.data?.error || 'Backend error';
          toast.warning(`${errorMsg} - using local file`);
        } else {
          toast.info('Backend not available - using local file');
        }
      });

    // Set a maximum wait time (3 seconds) before proceeding
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve(null), 3000);
    });

    // Wait for either upload to complete or timeout (whichever comes first)
    try {
      await Promise.race([uploadPromise, timeoutPromise]);
    } catch (error) {
      // Ignore errors - we'll use local file
      console.warn('Upload error (non-blocking):', error);
    }

    // ALWAYS proceed to voice selection, regardless of upload status
    console.log('✅ Navigating to voice selection with PDF:', uploadedFile.name);
    setIsUploading(false);
    onFileUploaded(uploadedFile, pdfUrl);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="space-y-2">
        <h1>Upload Your PDF</h1>
        <p className="text-muted-foreground">
          Select a PDF document to convert into an audiobook
        </p>
      </div>

      {/* Drag and Drop Zone */}
      <Card
        className={`transition-all duration-300 ${
          isDragging 
            ? "border-primary border-2 bg-primary/5 glow-purple" 
            : uploadedFile
            ? "border-green-500 border-2"
            : "border-dashed border-2 border-border"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <CardContent className="p-12">
          <div className="flex flex-col items-center justify-center space-y-6 text-center">
            {uploadedFile ? (
              <>
                <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-green-500" />
                </div>
                <div className="space-y-2">
                  <h3>File Ready</h3>
                  <p className="text-muted-foreground">
                    {uploadedFile.name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {(uploadedFile.size / (1024 * 1024)).toFixed(2)} MB
                  </p>
                </div>
                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    onClick={() => setUploadedFile(null)}
                  >
                    Change File
                  </Button>
                  <Button
                    className="bg-primary hover:bg-primary/90 text-primary-foreground"
                    onClick={handleContinue}
                    disabled={isUploading}
                  >
                    {isUploading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      'Continue to Voice Selection'
                    )}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-colors ${
                  isDragging ? "bg-primary/20" : "bg-muted"
                }`}>
                  <Upload className={`w-8 h-8 ${isDragging ? "text-primary" : "text-muted-foreground"}`} />
                </div>
                <div className="space-y-2">
                  <h3>{isDragging ? "Drop your PDF here" : "Drag & drop your PDF"}</h3>
                  <p className="text-muted-foreground">
                    or click to browse your files
                  </p>
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
      <Card className="bg-card border-border">
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <FileText className="w-6 h-6 text-primary shrink-0 mt-1" />
            <div className="space-y-2">
              <h4>Supported Formats</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• PDF documents (.pdf)</li>
                <li>• Maximum file size: 100 MB</li>
                <li>• Text-based PDFs work best</li>
                <li>• Scanned documents may require OCR preprocessing</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tips */}
      <Card className="bg-card border-border">
        <CardContent className="p-6">
          <div className="space-y-4">
            <h4>Tips for Best Results</h4>
            <ul className="text-sm text-muted-foreground space-y-2">
              <li>✓ Use high-quality PDFs with clear, readable text</li>
              <li>✓ Remove unnecessary pages (covers, blank pages) for faster processing</li>
              <li>✓ Ensure the PDF is not password-protected</li>
              <li>✓ For academic papers, consider splitting into chapters</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
