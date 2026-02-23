import * as pdfjsLib from 'pdfjs-dist';

// Set worker source - use a more reliable CDN or local worker
try {
  // Try using unpkg CDN as fallback
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.js`;
} catch (e) {
  // Fallback to cdnjs
  pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
}

export async function extractTextFromPDF(file: File): Promise<string> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ 
      data: arrayBuffer,
      useWorkerFetch: false,
      isEvalSupported: false,
      verbosity: 0 // Suppress warnings
    }).promise;
    
    let fullText = '';
    
    // Limit to first 10 pages for performance
    const maxPages = Math.min(10, pdf.numPages);
    
    for (let i = 1; i <= maxPages; i++) {
      try {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item: any) => item.str)
          .join(' ');
        fullText += pageText + '\n\n';
      } catch (pageError) {
        console.warn(`Failed to extract text from page ${i}:`, pageError);
        // Continue with other pages
      }
    }
    
    return fullText.trim() || 'Text extraction completed (some pages may be unreadable)';
  } catch (error) {
    console.warn('PDF extraction error (non-blocking):', error);
    // Return empty string instead of throwing - extraction is optional
    return '';
  }
}

export async function getPDFPreview(file: File, maxPages = 3): Promise<string> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    
    let previewText = '';
    const pagesToExtract = Math.min(maxPages, pdf.numPages);
    
    for (let i = 1; i <= pagesToExtract; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ');
      previewText += pageText + '\n\n';
    }
    
    return previewText.trim();
  } catch (error) {
    console.error('PDF preview extraction error:', error);
    throw new Error('Failed to extract PDF preview');
  }
}

