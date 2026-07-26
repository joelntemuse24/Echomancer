/**
 * Paragraph-aware text splitting for TTS windows.
 */

export function splitTextForTts(
  text: string,
  maxChars: number
): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return [];
  if (maxChars < 10) maxChars = 10;

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) {
      chunks.push(current.trim());
      current = "";
    }
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      flush();
      // Split long paragraph on sentence boundaries
      const sentences = para.match(/[^.!?]+[.!?]+[\s]*/g) || [para];
      let buf = "";
      for (const sentence of sentences) {
        if ((buf + sentence).length > maxChars) {
          if (buf.trim()) chunks.push(buf.trim());
          if (sentence.length > maxChars) {
            // Hard split
            for (let i = 0; i < sentence.length; i += maxChars) {
              chunks.push(sentence.slice(i, i + maxChars).trim());
            }
            buf = "";
          } else {
            buf = sentence;
          }
        } else {
          buf += sentence;
        }
      }
      if (buf.trim()) chunks.push(buf.trim());
      continue;
    }

    if (!current) {
      current = para;
    } else if ((current + "\n\n" + para).length <= maxChars) {
      current = current + "\n\n" + para;
    } else {
      flush();
      current = para;
    }
  }
  flush();
  return chunks;
}
