import { useState } from "react";
import { LandingPage } from "./components/LandingPage";
import { DashboardLayout } from "./components/DashboardLayout";
import { PDFUploadPage } from "./components/PDFUploadPage";
import { VoiceSelectionPage } from "./components/VoiceSelectionPage";
import { VoiceClippingPage } from "./components/VoiceClippingPage";
import { QueuePage } from "./components/QueuePage";
import { PlayerPage } from "./components/PlayerPage";
import { SubscriptionPage } from "./components/SubscriptionPage";
import { ResourcesPage } from "./components/ResourcesPage";

type Page = 
  | "landing"
  | "new-audiobook"
  | "upload-pdf"
  | "voice-selection"
  | "voice-clipping"
  | "queue"
  | "player"
  | "subscription"
  | "resources";

interface AudiobookState {
  file?: File;
  pdfUrl?: string;
  videoId?: string;
  videoTitle?: string;
  audioSampleUrl?: string;
  startTime?: number;
  endTime?: number;
  currentAudiobookId?: string;
  currentAudiobookTitle?: string;
}

export default function App() {
  const [currentPage, setCurrentPage] = useState<Page>("landing");
  const [audiobookState, setAudiobookState] = useState<AudiobookState>({});

  const handleGetStarted = () => {
    setCurrentPage("new-audiobook");
  };

  const handleNavigate = (page: Page) => {
    setCurrentPage(page);
  };

  const handleFileUploaded = (file: File, pdfUrl: string) => {
    setAudiobookState({ ...audiobookState, file, pdfUrl });
    setCurrentPage("voice-selection");
  };

  const handleVideoSelected = (videoId: string, videoTitle: string) => {
    setAudiobookState({ ...audiobookState, videoId, videoTitle });
    setCurrentPage("voice-clipping");
  };

  const handleManualUpload = () => {
    console.log('=== MANUAL UPLOAD STARTED ===');
    // Create a file input element
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.mp3,.wav,.m4a,.ogg';
    input.onchange = async (e: Event) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      console.log('File selected:', file);
      if (file) {
        // Check file size (50MB limit)
        const maxSize = 50 * 1024 * 1024; // 50MB
        if (file.size > maxSize) {
          const { toast } = await import("sonner");
          toast.error(`File too large (${(file.size / (1024 * 1024)).toFixed(2)}MB). Maximum size is 50MB.`);
          return;
        }

        const { toast } = await import("sonner");
        toast.info('Uploading audio file...');

        try {
          // Upload audio file
          const { audioApi } = await import("./lib/api");

          console.log('Calling audioApi.uploadSample...');
          const result = await audioApi.uploadSample(file);
          console.log('Upload result:', result);

          // Handle local file URLs (when Bunny.net not configured)
          let audioUrl = result.audioUrl;
          console.log('Audio URL from backend:', audioUrl);

          if (audioUrl && audioUrl.startsWith('local://')) {
            // Create a local object URL for the file
            audioUrl = URL.createObjectURL(file);
            toast.info('Using local file (CDN not configured)');
          }

          console.log('Final audioUrl to save in state:', audioUrl);

          // Use the uploaded audio as the voice sample
          setAudiobookState((prevState) => {
            console.log('Previous state:', prevState);
            const newState = {
              ...prevState,
              audioSampleUrl: audioUrl,
              videoId: 'uploaded-audio',
              videoTitle: file.name
            };
            console.log('New state:', newState);
            return newState;
          });

          toast.success('Audio sample uploaded! Proceeding to voice clipping...');

          // Go directly to clipping page
          console.log('Navigating to voice-clipping page');
          setCurrentPage("voice-clipping");
        } catch (error: any) {
          console.error('Audio upload error:', error);
          
          // Extract error message
          let errorMessage = 'Failed to upload audio file';
          if (error.response?.data?.error) {
            errorMessage = error.response.data.error;
            if (error.response.data.message) {
              errorMessage += ': ' + error.response.data.message;
            }
          } else if (error.message) {
            errorMessage = error.message;
          }
          
          toast.error(errorMessage, { duration: 5000 });
          
          // Still allow using local file
          const localUrl = URL.createObjectURL(file);
          setAudiobookState((prevState) => ({
            ...prevState,
            audioSampleUrl: localUrl,
            videoId: 'uploaded-audio',
            videoTitle: file.name
          }));
          toast.info('Using local file instead');
          setCurrentPage("voice-clipping");
        }
      }
    };
    input.click();
  };

  const handleUseClip = async (startTime: number, endTime: number) => {
    try {
      const { queueApi } = await import("./lib/api");
      const { toast } = await import("sonner");

      // DEBUG: Log the entire state
      console.log("DEBUG: Full audiobookState:", audiobookState);

      // CRITICAL: Send audioSampleUrl if available, otherwise videoId
      console.log("DEBUG: Creating job with:", {
        pdfUrl: audiobookState.pdfUrl,
        videoId: audiobookState.audioSampleUrl ? undefined : audiobookState.videoId,
        audioSampleUrl: audiobookState.audioSampleUrl,
        startTime,
        endTime,
      });

      const result = await queueApi.create({
        pdfUrl: audiobookState.pdfUrl || "",
        videoId: audiobookState.audioSampleUrl ? undefined : audiobookState.videoId,
        audioSampleUrl: audiobookState.audioSampleUrl,
        startTime,
        endTime,
      });
      
      toast.success("Audiobook added to queue!");
      setCurrentPage("queue");
      // Reset state for next audiobook
      setAudiobookState({});
    } catch (error: any) {
      const { toast } = await import("sonner");
      toast.error(error.message || "Failed to create audiobook job");
    }
  };

  const handleBackFromClipping = () => {
    setCurrentPage("voice-selection");
  };

  const handlePlayAudiobook = (id: string) => {
    setAudiobookState({
      ...audiobookState,
      currentAudiobookId: id,
      currentAudiobookTitle: "The Great Gatsby.pdf"
    });
    setCurrentPage("player");
  };

  const handleDownloadAudiobook = (id: string) => {
    alert(`Downloading audiobook ${id}...`);
  };

  const handleBackFromPlayer = () => {
    setCurrentPage("queue");
  };

  const renderPage = () => {
    if (currentPage === "landing") {
      return <LandingPage onGetStarted={handleGetStarted} />;
    }

    // All other pages use dashboard layout
    const dashboardPage = currentPage === "player" ? "queue" : 
                         currentPage === "upload-pdf" ? "new-audiobook" :
                         currentPage === "voice-selection" ? "new-audiobook" :
                         currentPage === "voice-clipping" ? "new-audiobook" : currentPage;

    return (
      <DashboardLayout 
        currentPage={dashboardPage as any}
        onNavigate={handleNavigate}
      >
        {currentPage === "new-audiobook" && (
          <PDFUploadPage onFileUploaded={handleFileUploaded} />
        )}
        {currentPage === "upload-pdf" && (
          <PDFUploadPage onFileUploaded={handleFileUploaded} />
        )}
        {currentPage === "voice-selection" && (
          <VoiceSelectionPage
            onVideoSelected={handleVideoSelected}
            onManualUpload={handleManualUpload}
          />
        )}
        {currentPage === "voice-clipping" && audiobookState.videoId && (
          <VoiceClippingPage
            videoId={audiobookState.videoId}
            videoTitle={audiobookState.videoTitle || ""}
            onUseClip={handleUseClip}
            onBack={handleBackFromClipping}
          />
        )}
        {currentPage === "queue" && (
          <QueuePage
            onPlayAudiobook={handlePlayAudiobook}
            onDownloadAudiobook={handleDownloadAudiobook}
          />
        )}
        {currentPage === "player" && audiobookState.currentAudiobookId && (
          <PlayerPage
            audiobookId={audiobookState.currentAudiobookId}
            bookTitle={audiobookState.currentAudiobookTitle || ""}
            onBack={handleBackFromPlayer}
            onDownload={() => handleDownloadAudiobook(audiobookState.currentAudiobookId!)}
          />
        )}
        {currentPage === "subscription" && <SubscriptionPage />}
        {currentPage === "resources" && <ResourcesPage />}
      </DashboardLayout>
    );
  };

  return (
    <div className="dark min-h-screen bg-background">
      {renderPage()}
    </div>
  );
}