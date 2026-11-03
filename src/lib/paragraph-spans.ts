/**
 * Paragraph spans for a speakable book.
 *
 * Chapter detection, printed-contents alignment, and the heading-candidate
 * list all need the same thing: the book split on blank lines, with each
 * paragraph's character offset preserved. Three modules had byte-identical
 * copies of this walk; they share one now.
 */

export type ParagraphSpan = {
  /** Paragraph text, without the separator that followed it. */
  text: string;
  /** Offset of this paragraph in the input string. */
  start: number;
};

export function paragraphSpans(spoken: string): ParagraphSpan[] {
  const text = spoken.replace(/\r\n/g, "\n");
  const spans: ParagraphSpan[] = [];
  const re = /\n\s*\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    spans.push({ text: text.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  spans.push({ text: text.slice(start), start });
  return spans;
}
