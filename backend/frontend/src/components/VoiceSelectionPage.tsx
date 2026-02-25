import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Search, Clock, Upload, Loader2 } from "lucide-react";
import { useState, useRef } from "react";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { useQuery } from "@tanstack/react-query";
import { youtubeApi } from "../lib/api";
import { toast } from "sonner";

interface VoiceSelectionPageProps {
  onVideoSelected: (videoId: string, videoTitle: string) => void;
  onManualUpload: () => void;
}

interface Video {
  id: string;
  title: string;
  channel: string;
  duration?: string;
  thumbnail: string;
  publishedAt?: string;
}

const mockVideos: Video[] = [
  {
    id: "1",
    title: "The Art of Storytelling - Full Narration Guide",
    channel: "Narrative Voice",
    duration: "12:45",
    thumbnail: "https://images.unsplash.com/photo-1676380364777-d53c900178fa?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHx5b3V0dWJlJTIwdmlkZW8lMjB0aHVtYm5haWx8ZW58MXx8fHwxNzY0NzY5NDM2fDA&ixlib=rb-4.1.0&q=80&w=1080"
  },
  {
    id: "2",
    title: "Professional Voice Acting Techniques",
    channel: "Voice Academy",
    duration: "18:32",
    thumbnail: "https://images.unsplash.com/photo-1709846487437-7445553bb6ed?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwb2RjYXN0JTIwbWljcm9waG9uZSUyMHN0dWRpb3xlbnwxfHx8fDE3NjQ3NzQyNTl8MA&ixlib=rb-4.1.0&q=80&w=1080"
  },
  {
    id: "3",
    title: "Documentary Narration Masterclass",
    channel: "Doc Voice Pro",
    duration: "25:10",
    thumbnail: "https://images.unsplash.com/photo-1758873268998-2f77c2d38862?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwZXJzb24lMjBzcGVha2luZyUyMHByZXNlbnRlcnxlbnwxfHx8fDE3NjQ4MDk3MDd8MA&ixlib=rb-4.1.0&q=80&w=1080"
  },
  {
    id: "4",
    title: "Audiobook Reading Tips & Tricks",
    channel: "AudioBook Masters",
    duration: "15:20",
    thumbnail: "https://images.unsplash.com/photo-1676380364777-d53c900178fa?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHx5b3V0dWJlJTIwdmlkZW8lMjB0aHVtYm5haWx8ZW58MXx8fHwxNzY0NzY5NDM2fDA&ixlib=rb-4.1.0&q=80&w=1080"
  },
  {
    id: "5",
    title: "Clear Voice Training for Narrators",
    channel: "Voice Coach Jane",
    duration: "22:15",
    thumbnail: "https://images.unsplash.com/photo-1709846487437-7445553bb6ed?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwb2RjYXN0JTIwbWljcm9waG9uZSUyMHN0dWRpb3xlbnwxfHx8fDE3NjQ3NzQyNTl8MA&ixlib=rb-4.1.0&q=80&w=1080"
  },
  {
    id: "6",
    title: "British Accent Narration Examples",
    channel: "Accent Studio",
    duration: "10:45",
    thumbnail: "https://images.unsplash.com/photo-1758873268998-2f77c2d38862?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwZXJzb24lMjBzcGVha2luZyUyMHByZXNlbnRlcnxlbnwxfHx8fDE3NjQ4MDk3MDd8MA&ixlib=rb-4.1.0&q=80&w=1080"
  },
];

export function VoiceSelectionPage({ onVideoSelected, onManualUpload }: VoiceSelectionPageProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState(""); // Submitted search term
  const searchInputRef = useRef<HTMLInputElement>(null);

  // React Query - automatically fetches when searchTerm changes
  const { data, isLoading: isSearching, error } = useQuery({
    queryKey: ['youtube-search', searchTerm],
    queryFn: () => youtubeApi.search(searchTerm, 10),
    enabled: searchTerm.length > 0, // Only search when we have a term
    retry: false, // Don't retry on error
  });

  // Show error toast when search fails
  if (error) {
    console.error('YouTube search error:', error);
    toast.error((error as Error).message || 'Failed to search YouTube', {
      duration: 8000,
    });
  }

  const videos = data?.videos || [];

  // Show toast when no results found
  if (data && videos.length === 0 && searchTerm) {
    // Using a ref or effect would be better, but this works for demo
  }

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setSearchTerm("");
      return;
    }
    setSearchTerm(searchQuery.trim()); // This triggers the tRPC query
  };

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      <div className="space-y-2">
        <h1>Select a Voice</h1>
        <p className="text-muted-foreground">
          Search YouTube for videos with voices you'd like to use, or upload your own audio sample
        </p>
      </div>

      {/* Search Bar */}
      <Card className="bg-card border-border">
        <CardContent className="p-6">
          <form onSubmit={handleSearch} className="space-y-4">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-muted-foreground z-10" />
              <Input
                ref={searchInputRef}
                type="text"
                placeholder="Search for voices on YouTube... (e.g., 'audiobook narration', 'documentary voice')"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-12 pr-12 py-6 text-lg bg-background border-2 border-border focus:border-primary"
                disabled={isSearching}
              />
              {isSearching ? (
                <Loader2 className="absolute right-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-primary animate-spin" />
              ) : (
                <Button
                  type="submit"
                  className="absolute right-2 top-1/2 transform -translate-y-1/2"
                  size="sm"
                >
                  Search
                </Button>
              )}
            </div>
            {!searchQuery && (
              <p className="text-sm text-muted-foreground text-center">
                💡 Tip: Search for terms like "audiobook", "narration", "voice acting", or specific accents
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      {/* Manual Upload Option */}
      <Card className="bg-card border-border border-dashed hover:border-primary transition-colors">
        <CardContent className="p-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-4 flex-1">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Upload className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h4 className="font-semibold">Upload Your Own Audio Sample</h4>
                <p className="text-sm text-muted-foreground">
                  Have a voice recording? Upload MP3, WAV, or M4A files directly
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Supported formats: MP3, WAV, M4A, OGG • Max 50MB
                </p>
              </div>
            </div>
            <Button 
              variant="outline" 
              onClick={onManualUpload}
              className="gap-2 min-w-[140px]"
            >
              <Upload className="w-4 h-4" />
              Upload Audio
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Video Grid */}
      <div className="space-y-4">
        {videos.length > 0 && (
          <>
            <div className="flex items-center justify-between">
              <h3>Search Results</h3>
              <p className="text-sm text-muted-foreground">
                {videos.length} videos found
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {videos.map((video) => (
            <Card
              key={video.id}
              className="bg-card border-border hover:border-primary transition-all cursor-pointer group"
              onClick={() => onVideoSelected(video.id, video.title)}
            >
              <CardContent className="p-0">
                <div className="relative aspect-video bg-muted overflow-hidden rounded-t-lg">
                  <ImageWithFallback
                    src={video.thumbnail}
                    alt={video.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                  <div className="absolute bottom-2 right-2 bg-black/80 text-white px-2 py-1 rounded text-xs flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {video.duration}
                  </div>
                </div>
                <div className="p-4 space-y-2">
                  <h4 className="line-clamp-2 group-hover:text-primary transition-colors">
                    {video.title}
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    {video.channel}
                  </p>
                </div>
              </CardContent>
            </Card>
              ))}
            </div>
          </>
        )}

        {videos.length === 0 && !isSearching && (
          <Card 
            className="bg-muted/30 border-border hover:border-primary/50 transition-colors cursor-pointer"
            onClick={() => {
              // Focus the search input when clicking the card
              searchInputRef.current?.focus();
            }}
          >
            <CardContent className="p-12">
              <div className="text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto">
                  <Search className="w-8 h-8 text-muted-foreground" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold mb-2">
                    {searchQuery ? 'No videos found' : 'Ready to search'}
                  </h3>
                  <p className="text-muted-foreground">
                    {searchQuery 
                      ? 'Try a different search term or check your YouTube API key is configured.'
                      : 'Click here or enter a search term above to find YouTube videos with voices you want to use, or upload your own audio sample below.'}
                  </p>
                  {!searchQuery && (
                    <Button
                      variant="outline"
                      className="mt-4"
                      onClick={(e) => {
                        e.stopPropagation();
                        searchInputRef.current?.focus();
                      }}
                    >
                      <Search className="w-4 h-4 mr-2" />
                      Start Searching
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
