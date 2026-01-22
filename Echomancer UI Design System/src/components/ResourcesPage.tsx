import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { ExternalLink, BookOpen } from "lucide-react";

interface Resource {
  name: string;
  url: string;
  description: string;
  collection: string;
}

const resources: Resource[] = [
  {
    name: "Project Gutenberg",
    url: "https://www.gutenberg.org",
    description: "Over 70,000 free eBooks, primarily classics",
    collection: "General"
  },
  {
    name: "Standard Ebooks",
    url: "https://standardebooks.org",
    description: "High-quality, carefully formatted public domain books",
    collection: "General"
  },
  {
    name: "Internet Archive",
    url: "https://archive.org/details/texts",
    description: "Millions of free books, texts, and documents",
    collection: "General"
  },
  {
    name: "Open Library",
    url: "https://openlibrary.org",
    description: "Digital library with over 1.7 million free eBooks",
    collection: "General"
  },
  {
    name: "ManyBooks",
    url: "https://manybooks.net",
    description: "50,000+ free eBooks in multiple formats",
    collection: "General"
  },
  {
    name: "Feedbooks Public Domain",
    url: "https://www.feedbooks.com/publicdomain",
    description: "Classic literature in modern digital formats",
    collection: "General"
  },
  {
    name: "LibriVox",
    url: "https://librivox.org",
    description: "Free public domain audiobooks (for reference)",
    collection: "Audio Reference"
  },
  {
    name: "Europeana",
    url: "https://www.europeana.eu",
    description: "European cultural heritage digital library",
    collection: "Academic"
  },
  {
    name: "arXiv",
    url: "https://arxiv.org",
    description: "Open-access archive of scientific papers",
    collection: "Academic"
  },
  {
    name: "JSTOR Open Content",
    url: "https://www.jstor.org/open",
    description: "Free scholarly content and research",
    collection: "Academic"
  },
];

export function ResourcesPage() {
  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="space-y-2">
        <h1>Free PDF Resources</h1>
        <p className="text-muted-foreground">
          Discover public domain books and documents you can legally convert to audiobooks
        </p>
      </div>

      {/* Important Notice */}
      <Card className="bg-primary/5 border-primary/20">
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <BookOpen className="w-6 h-6 text-primary shrink-0 mt-1" />
            <div className="space-y-2">
              <h4 className="text-primary">About Public Domain Content</h4>
              <p className="text-sm text-muted-foreground">
                All resources listed below provide content in the public domain or with appropriate licenses. 
                Always verify the licensing status before converting content to audiobooks. echomancer is not 
                responsible for copyright verification - users must ensure they have the right to use the content.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Resources Table */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>Public Domain Libraries</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>
                  <th className="text-left p-4 font-semibold">Name</th>
                  <th className="text-left p-4 font-semibold hidden md:table-cell">Description</th>
                  <th className="text-left p-4 font-semibold hidden sm:table-cell">Collection</th>
                  <th className="text-left p-4 font-semibold">Link</th>
                </tr>
              </thead>
              <tbody>
                {resources.map((resource, index) => (
                  <tr 
                    key={index}
                    className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                  >
                    <td className="p-4">
                      <div className="font-medium">{resource.name}</div>
                      <div className="text-sm text-muted-foreground md:hidden mt-1">
                        {resource.description}
                      </div>
                    </td>
                    <td className="p-4 text-sm text-muted-foreground hidden md:table-cell">
                      {resource.description}
                    </td>
                    <td className="p-4 hidden sm:table-cell">
                      <span className="inline-block px-2 py-1 bg-muted rounded text-xs">
                        {resource.collection}
                      </span>
                    </td>
                    <td className="p-4">
                      <a
                        href={resource.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-primary hover:underline"
                      >
                        Visit
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Tips Card */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>Tips for Finding Great Content</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3 text-sm">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-xs font-semibold text-primary">1</span>
              </div>
              <div>
                <strong>Check Publication Dates:</strong> Books published before 1928 in the US are generally in the public domain.
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-xs font-semibold text-primary">2</span>
              </div>
              <div>
                <strong>Look for Quality PDFs:</strong> Standard Ebooks provides beautifully formatted versions of classics.
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-xs font-semibold text-primary">3</span>
              </div>
              <div>
                <strong>Academic Papers:</strong> Many research papers on arXiv are freely available for educational use.
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-xs font-semibold text-primary">4</span>
              </div>
              <div>
                <strong>Text Quality Matters:</strong> PDFs with clear, machine-readable text produce the best audiobook results.
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
