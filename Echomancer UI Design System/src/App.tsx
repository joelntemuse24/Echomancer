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
  videoId?: string;
  videoTitle?: string;
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

  const handleFileUploaded = (file: File) => {
    setAudiobookState({ ...audiobookState, file });
    setCurrentPage("voice-selection");
  };

  const handleVideoSelected = (videoId: string, videoTitle: string) => {
    setAudiobookState({ ...audiobookState, videoId, videoTitle });
    setCurrentPage("voice-clipping");
  };

  const handleManualUpload = () => {
    // In a real app, this would open a file picker
    alert("Manual audio upload would be implemented here");
  };

  const handleUseClip = (startTime: number, endTime: number) => {
    setAudiobookState({ ...audiobookState, startTime, endTime });
    // Simulate adding to queue
    alert("Audiobook added to queue! Redirecting...");
    setCurrentPage("queue");
    // Reset state for next audiobook
    setAudiobookState({});
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