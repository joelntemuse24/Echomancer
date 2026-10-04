/**
 * Leading copyright / catalog pages are not narration.
 *
 * Only lines that are unmistakably a notice are removed, and only before
 * the first sentence or real heading (Preface, Chapter, Part, …). A sentence
 * that mentions copyright stays. Set `TTS_SKIP_FRONT_MATTER=0` to read the
 * page anyway.
 */

const NOTICE_CHARS = 240;

function looksLikeSentence(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 8 || !/[.!?]["”’]?$/.test(text.trim())) return false;
  return /[a-z]{3,}/.test(text);
}

/** ISBN, copyright notice, edition, imprint, or catalog line. Not a sentence. */
export function isNarrationBoilerplate(block: string): boolean {
  const t = block.replace(/\s+/g, " ").trim();
  if (!t || t.length > NOTICE_CHARS) return false;
  if (/^ISBN\b/i.test(t)) return true;
  if (/\bISBN(?:-1[03])?\b/i.test(t) && /\d(?:[-\s]?\d){8,}/.test(t)) return true;
  if (/^p\.\s*cm\.?$/i.test(t)) return true;
  if (/^(?:\d{1,2}\s+){5,}\d{1,2}$/.test(t)) return true;
  if (/\bcatalogu?ing[- ]in[- ]publication\b/i.test(t)) return true;
  if (/\blibrary of congress\b/i.test(t) && !looksLikeSentence(t)) return true;
  if (/^(?:copyright|©)\b/i.test(t) && !isCopyrightDiscussion(t)) return true;
  if (/\ball rights reserved\b/i.test(t) && t.length < 180 && !isCopyrightDiscussion(t)) {
    return true;
  }
  if (isEditionNotice(t)) return true;
  if (/^(?:published by|printed in|printing history)\b/i.test(t)) return true;
  return false;
}

function isCopyrightDiscussion(text: string): boolean {
  if (!looksLikeSentence(text)) return false;
  return !/\ball rights reserved\b/i.test(text);
}

function isEditionNotice(text: string): boolean {
  if (text.length > 80) return false;
  return (
    /^(?:(?:the|a)\s+)?(?:first|second|third|fourth|new|revised|\d+(?:st|nd|rd|th))\b/i.test(
      text
    ) && /\bedition\b/i.test(text)
  );
}

/** Preface, Introduction, Chapter, Part, Book — the reading has started. */
function isBodyHeading(block: string): boolean {
  const t = block.trim();
  if (!t || t.length > 120) return false;
  return /^(?:preface|introduction|foreword|prologue|epilogue|afterword|chapter|part|book|volume|section)\b/i.test(
    t
  );
}

function isProseStart(block: string): boolean {
  const t = block.trim();
  if (t.length < 80) return false;
  if (!/[.!?]["”’]?$/.test(t) && t.length < 140) return false;
  return /[a-z]{3,}/.test(t);
}

export function narrationFrontMatterEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.TTS_SKIP_FRONT_MATTER !== "0";
}

/**
 * Drop a leading copyright page. The rest of the book is copied through.
 * With no body to keep, the text is returned unchanged.
 */
export function stripNarrationFrontMatter(
  text: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!text.trim() || !narrationFrontMatterEnabled(env)) return text;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split(/\n\s*\n/);
  const blocks = parts.map((part) => part.trim()).filter(Boolean);
  if (blocks.length === 0) return text;

  let bodyAt = -1;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (isBodyHeading(block) || isProseStart(block)) {
      bodyAt = i;
      break;
    }
  }
  if (bodyAt <= 0) return text;

  const kept: string[] = [];
  for (let i = 0; i < bodyAt; i++) {
    if (isNarrationBoilerplate(blocks[i]!)) continue;
    kept.push(blocks[i]!);
  }
  kept.push(...blocks.slice(bodyAt));
  const next = kept.join("\n\n").trim();
  return next || text;
}
