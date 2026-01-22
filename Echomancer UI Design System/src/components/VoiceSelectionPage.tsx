import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Search, Clock, Upload } from "lucide-react";
import { useState } from "react";
import { ImageWithFallback } from "./figma/ImageWithFallback";

interface VoiceSelectionPageProps {
  onVideoSelected: (videoId: string, videoTitle: string) => void;
  onManualUpload: () => void;
}

interface MockVideo {
  id: string;
  title: string;
  channel: string;
  duration: string;
  thumbnail: string;
}

const mockVideos: MockVideo[] = [
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
  const [filteredVideos, setFilteredVideos] = useState(mockVideos);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      const filtered = mockVideos.filter(
        video =>
          video.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          video.channel.toLowerCase().includes(searchQuery.toLowerCase())
      );
      setFilteredVideos(filtered);
    } else {
      setFilteredVideos(mockVideos);
    }
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
      <form onSubmit={handleSearch} className="relative">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search for voices on YouTube..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-12 pr-4 py-6 text-lg bg-card border-border"
          />
        </div>
      </form>

      {/* Manual Upload Option */}
      <Card className="bg-card border-border border-dashed">
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                <Upload className="w-6 h-6 text-muted-foreground" />
              </div>
              <div>
                <h4>Upload Your Own Audio Sample</h4>
                <p className="text-sm text-muted-foreground">
                  Have a voice recording? Upload it directly
                </p>
              </div>
            </div>
            <Button variant="outline" onClick={onManualUpload}>
              Upload Audio
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Video Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3>Search Results</h3>
          <p className="text-sm text-muted-foreground">
            {filteredVideos.length} videos found
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredVideos.map((video) => (
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
      </div>

      {filteredVideos.length === 0 && (
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            No videos found. Try a different search term.
          </p>
        </div>
      )}
    </div>
  );
}
