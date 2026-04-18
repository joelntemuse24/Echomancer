import { createClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";
import * as https from "https";
import * as http from "http";

interface GenerateParams {
  jobId: string;
  pdfStoragePath: string;
  voiceStoragePath: string | null;
  voiceStoragePaths?: string[]; // Multi-reference support
  videoId: string | null;
  startTime: number;
  endTime: number;
}

interface ProgressCheckpoint {
  sectionIndex: number;
  audioPath: string;
  timestamp: string;
  textLength: number;
}


function getSupabase() {
  const env = getEnv();
  return createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY
  );
}

/**
 * SIMPLIFIED audiobook generation with:
 * - Sentence-aware text splitting (natural boundaries)
 * - Audio crossfading for smooth transitions
 * - Removed Gemini QA (replaced with better preprocessing)
 * - Simplified retry (network failures only)
 * - Better voice sample validation
 */
export async function generateAudiobookV2(params: GenerateParams) {
  const { jobId, pdfStoragePath, voiceStoragePath, voiceStoragePaths, videoId, startTime, endTime } = params;
  const supabase = getSupabase();
  
  const env = getEnv();
  const modalUrl = env.MODAL_TTS_URL;
  if (!modalUrl) {
    await updateJob(supabase, jobId, { 
      status: "failed", 
      error: "MODAL_TTS_URL not configured" 
    });
    return;
  }

  // Track partial progress for resume capability
  const checkpoints: ProgressCheckpoint[] = [];
  const jobStartTime = Date.now();

  try {
    await updateJob(supabase, jobId, { status: "processing", progress: 5 });

    // ========== Pre-warm Modal container ==========
    if (modalUrl) {
      try {
        console.log(`[Job ${jobId}] Pre-warming Modal container...`);
        fetch(modalUrl, { method: "GET", signal: AbortSignal.timeout(10_000) }).catch(() => {});
      } catch {
        // Non-critical, ignore
      }
    }

    // ========== Step 1: Download & extract PDF ==========
    const rawText = await extractDocumentText(supabase, pdfStoragePath);
    console.log(`[Job ${jobId}] Extracted ${rawText.length} characters (raw)`);
    
    // Clean up PDF artifacts for better TTS
    const text = preprocessPDFText(rawText, jobId);
    console.log(`[Job ${jobId}] Preprocessed to ${text.length} characters`);
    await updateJob(supabase, jobId, { progress: 10 });

    // ========== Step 2: Prepare voice sample(s) with clipping ==========
    // Support multi-reference: use voiceStoragePaths if available, otherwise fall back to single path
    const voicePaths = voiceStoragePaths && voiceStoragePaths.length > 0 
      ? voiceStoragePaths 
      : voiceStoragePath 
        ? [voiceStoragePath] 
        : [];
    
    if (voicePaths.length === 0) {
      throw new Error("No voice samples provided");
    }
    
    const voiceSample = await prepareVoiceSamples(
      supabase, 
      voicePaths, 
      videoId,
      startTime, 
      endTime,
      jobId
    );
    console.log(`[Job ${jobId}] Voice sample ready (${voiceSample.length} bytes) using ${voicePaths.length} reference(s)`);
    await updateJob(supabase, jobId, { progress: 20 });

    // ========== Step 3: Sentence-aware text splitting ==========
    // Target: ~600 chars per chunk (~20 seconds audio)
    // Stays within F5-TTS's 30-second limit, better for long-form consistency
    const sections = splitBySentences(text, 600);
    console.log(`[Job ${jobId}] Split into ${sections.length} sentence-based sections`);
    
    // Estimate total generation time
    // F5-TTS: ~1.5s per chunk (GPU inference) + ~2s network overhead per batch
    // Emotion Director: ~1s per chunk (parallel)
    // Post-processing: ~5s
    const totalChars = sections.reduce((s, sec) => s + sec.text.length, 0);
    const estimatedBatchSize = sections.length <= 20 ? 8 : sections.length <= 50 ? 12 : 16;
    const estimatedBatchCount = Math.ceil(sections.length / estimatedBatchSize);
    const estimatedSeconds = Math.round(sections.length * 1.5 + estimatedBatchCount * 2 + 5);
    console.log(`[Job ${jobId}] ⏱ Estimate: ${totalChars} chars, ${sections.length} sections → ~${estimatedSeconds}s (${Math.round(estimatedSeconds / 60)}m${estimatedSeconds % 60}s)`);
    await updateJob(supabase, jobId, { progress: 25 });

    // Check for existing checkpoints (resume capability)
    const existingCheckpoints = await loadCheckpoints(supabase, jobId);
    if (existingCheckpoints.length > 0) {
      console.log(`[Job ${jobId}] Resuming from checkpoint, ${existingCheckpoints.length} sections done`);
      checkpoints.push(...existingCheckpoints);
    }

    // ========== Step 4: Generate audio via batch endpoint ==========
    // Dynamic batch size: smaller batches for short books (faster first audio),
    // larger for long books (less overhead). F5-TTS serializes via _lock anyway.
    const totalSections = sections.length;
    const BATCH_SIZE = totalSections <= 20 ? 8 : totalSections <= 50 ? 12 : 16;
    const voiceBase64 = voiceSample.toString("base64"); // Compute once
    const audioBuffers: Map<number, Buffer> = new Map(); // Keep in memory for concat

    // Derive batch endpoint URL from single-generate URL
    // Modal encodes method names in the hostname: *-generate.modal.run → *-generate-batch.modal.run
    const batchUrl = modalUrl.replace(/-generate.modal.run/, "-generate-batch.modal.run");

    for (let batchStart = 0; batchStart < totalSections; batchStart += BATCH_SIZE) {
      // Check for cancellation or deletion before starting a new batch
      const { data: jobStatus, error: fetchError } = await supabase
        .from("jobs")
        .select("status, error")
        .eq("id", jobId)
        .single();
        
      if (fetchError || (jobStatus?.status === "failed" && jobStatus?.error === "Cancelled by user")) {
        console.log(`[Job ${jobId}] Job cancelled or deleted, aborting generation loop.`);
        return;
      }

      const batchEnd = Math.min(batchStart + BATCH_SIZE, totalSections);
      const batch = sections.slice(batchStart, batchEnd);
      
      // Determine which sections in this batch still need generation
      const pendingIndices: number[] = [];
      const pendingTexts: string[] = [];
      for (let i = 0; i < batch.length; i++) {
        const sectionIndex = batchStart + i;
        const section = batch[i];
        if (!section) continue;
        if (checkpoints.some(c => c.sectionIndex === sectionIndex)) continue;
        pendingIndices.push(sectionIndex);
        // Strip trailing period — F5-TTS hallucinates "AS WE" after sentence-ending periods
        // The model still pauses naturally at sentence boundaries without the trailing period
        let chunkText = section.text.replace(/\.\s*$/, "");
        pendingTexts.push(chunkText);
      }

      if (pendingTexts.length === 0) {
        console.log(`[Job ${jobId}] Skipping sections ${batchStart + 1}-${batchEnd}/${totalSections} (already completed)`);
        continue;
      }

      console.log(`[Job ${jobId}] Batch generating sections ${batchStart + 1}-${batchEnd}/${totalSections} (${pendingTexts.length} pending)`);
      const batchStartTime = Date.now();

      // Get emotion-directed speeds + SML-marked up text (if Emotion Director is available)
      const emotionDirections = await getEmotionDirections(pendingTexts, jobId);
      
      // Use modified text with SML tags when available, otherwise raw text
      const ttsTexts = emotionDirections
        ? emotionDirections.map(d => d.modifiedText)
        : pendingTexts;
      const emotionSpeeds = emotionDirections
        ? emotionDirections.map(d => d.speed)
        : undefined;

      // Call batch endpoint: send all texts in one request
      let batchResults: Array<{ audio_base64: string; size: number; error?: string }> = [];
      let batchAttempt = 0;
      const maxBatchRetries = 3;

      while (batchAttempt < maxBatchRetries) {
        // Check for cancellation or deletion before each retry attempt
        const { data: currentStatus, error: retryFetchError } = await supabase
          .from("jobs")
          .select("status, error")
          .eq("id", jobId)
          .single();
        if (retryFetchError || (currentStatus?.status === "failed" && currentStatus?.error === "Cancelled by user")) {
          console.log(`[Job ${jobId}] Job cancelled or deleted during retry, aborting.`);
          return;
        }

        batchAttempt++;
        try {
          batchResults = await modalTTSBatch(
            batchUrl,
            ttsTexts,
            voiceBase64,
            jobId,
            emotionSpeeds,
          );
          break; // Success
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[Job ${jobId}] Batch attempt ${batchAttempt} failed: ${errMsg}`);
          if (batchAttempt < maxBatchRetries) {
            const delay = Math.min(1000 * Math.pow(2, batchAttempt), 30000);
            console.log(`[Job ${jobId}] Retrying batch in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
          } else {
            // If all retries fail with zero checkpoints, throw
            if (checkpoints.length === 0) {
              throw new Error(`Batch failed after ${maxBatchRetries} attempts: ${errMsg}`);
            }
            console.warn(`[Job ${jobId}] Batch failed, continuing with partial results`);
          }
        }
      }

      // Process batch results: upload checkpoints and keep buffers in memory
      const failedInBatch: number[] = [];
      for (let r = 0; r < batchResults.length; r++) {
        const result = batchResults[r];
        const sectionIndex = pendingIndices[r];
        if (!result || sectionIndex === undefined) {
          failedInBatch.push(sectionIndex ?? -1);
          continue;
        }
        if (result.error) {
          console.warn(`[Job ${jobId}] Section ${sectionIndex + 1} had error: ${result.error}`);
          failedInBatch.push(sectionIndex);
          continue;
        }
        if (!result.audio_base64) {
          console.warn(`[Job ${jobId}] Section ${sectionIndex + 1} returned no audio`);
          failedInBatch.push(sectionIndex);
          continue;
        }

        const audioBuffer = Buffer.from(result.audio_base64, "base64");
        audioBuffers.set(sectionIndex, audioBuffer);

        checkpoints.push({
          sectionIndex,
          audioPath: `chunks/${jobId}/section_${String(sectionIndex).padStart(4, '0')}.mp3`,
          timestamp: new Date().toISOString(),
          textLength: pendingTexts[r]?.length ?? 0,
        });
      }

      // If any chunks failed, throw to trigger the batch retry mechanism
      if (failedInBatch.length > 0) {
        throw new Error(`${failedInBatch.length} section(s) failed in batch: [${failedInBatch.join(', ')}]`);
      }

      // Log batch timing
      const batchElapsed = ((Date.now() - batchStartTime) / 1000).toFixed(1);
      const batchChars = pendingTexts.reduce((s, t) => s + t.length, 0);
      const charsPerSec = (batchChars / (Date.now() - batchStartTime) * 1000).toFixed(0);
      console.log(`[Job ${jobId}] ⏱ Batch done in ${batchElapsed}s (${batchChars} chars, ${charsPerSec} chars/s)`);
      
      // Batch checkpoint uploads: upload every 32 sections or at the end to reduce storage API calls
      const CHECKPOINT_UPLOAD_INTERVAL = 32;
      const isLastBatch = batchEnd >= totalSections;
      const sectionsSinceLastUpload = checkpoints.length % CHECKPOINT_UPLOAD_INTERVAL;
      if (sectionsSinceLastUpload === 0 || isLastBatch) {
        // Upload checkpoint audio files in bulk
        const recentCheckpoints = isLastBatch
          ? checkpoints.slice(-(checkpoints.length % CHECKPOINT_UPLOAD_INTERVAL) || CHECKPOINT_UPLOAD_INTERVAL)
          : checkpoints.slice(-CHECKPOINT_UPLOAD_INTERVAL);
        
        for (const cp of recentCheckpoints) {
          const buf = audioBuffers.get(cp.sectionIndex);
          if (!buf) continue;
          await supabase.storage
            .from("audiobooks")
            .upload(cp.audioPath, buf, {
              contentType: "audio/mpeg",
              upsert: true,
            });
        }
        // Save checkpoint metadata
        await saveCheckpoints(supabase, jobId, checkpoints);
        console.log(`[Job ${jobId}] Checkpoint batch saved (${recentCheckpoints.length} sections uploaded)`);

        // Free memory — chunks are safely in Supabase, will be downloaded during concat
        for (const cp of recentCheckpoints) {
          audioBuffers.delete(cp.sectionIndex);
        }
      }

      // Update progress
      const progress = 25 + Math.round((checkpoints.length / totalSections) * 55);
      await updateJob(supabase, jobId, { progress });
    }

    await updateJob(supabase, jobId, { progress: 85 });

    // ========== Step 5: Validate checkpoints ==========
    if (checkpoints.length === 0) {
      throw new Error("No audio sections were successfully generated. Cannot create audiobook.");
    }

    const sortedCheckpoints = [...checkpoints].sort((a, b) => a.sectionIndex - b.sectionIndex);

    // Fast validation: list storage directory instead of per-file HEAD requests
    const validCheckpoints = await validateCheckpointsFast(supabase, sortedCheckpoints, jobId);

    if (validCheckpoints.length === 0) {
      throw new Error("No valid audio files found. All generated sections failed to upload properly.");
    }

    console.log(`[Job ${jobId}] ${validCheckpoints.length} valid checkpoints.`);

    // ========== Step 6: Concatenate with real crossfading ==========
    // Use in-memory buffers when available, download only for resumed sections
    console.log(`[Job ${jobId}] Concatenating ${validCheckpoints.length} sections...`);
    let concatenatedAudio: Buffer = await concatenateFromBuffers(
      supabase, validCheckpoints, audioBuffers, jobId
    );

    // ========== Step 7: Post-processing — fix the "wiretap" sound ==========
    // F5-TTS outputs 24kHz MP3 which sounds muffled ("phone call" quality).
    // This pipeline:
    //   1. Upsamples 24kHz → 44.1kHz (allows frequencies up to 22kHz)
    //   2. Applies audiobook EQ: warmth (200Hz boost), presence (3kHz boost), air (12kHz shelf)
    //   3. Global loudnorm to -16 LUFS (audiobook standard, even volume throughout)
    console.log(`[Job ${jobId}] Post-processing: upsampling + EQ + loudnorm...`);
    concatenatedAudio = await postProcessAudio(concatenatedAudio, jobId);

    await updateJob(supabase, jobId, { progress: 95 });

    const outputPath = `output/${jobId}/audiobook.mp3`;
    const { error: uploadError } = await supabase.storage
      .from("audiobooks")
      .upload(outputPath, concatenatedAudio, {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Failed to upload final audiobook: ${uploadError.message}`);
    }

    // Compute chapter markers from sections that start chapters
    // Estimate timestamps: ~13 chars/sec at typical audiobook pace
    const CHARS_PER_SECOND = 13;
    const chapterMarkers: Array<{ title: string; startTime: number; sectionIndex: number }> = [];
    let charOffset = 0;
    let chapterNum = 1;
    for (const section of sections) {
      if (section.startsChapter) {
        const estimatedTime = Math.round(charOffset / CHARS_PER_SECOND);
        chapterMarkers.push({
          title: `Chapter ${chapterNum}`,
          startTime: estimatedTime,
          sectionIndex: chapterMarkers.length === 0 ? 0 : sections.indexOf(section),
        });
        chapterNum++;
      }
      charOffset += section.text.length;
    }

    await updateJob(supabase, jobId, {
      status: "ready",
      progress: 100,
      audio_storage_path: outputPath,
      error: null,
      chapters: chapterMarkers.length > 0 ? chapterMarkers : undefined,
    });

    const totalElapsed = ((Date.now() - jobStartTime) / 1000).toFixed(1);
    const totalMinutes = Math.floor(Number(totalElapsed) / 60);
    const totalSecs = Math.round(Number(totalElapsed) % 60);
    console.log(`[Job ${jobId}] ⏱ Complete in ${totalElapsed}s (${totalMinutes}m${totalSecs}s) — estimated ~${estimatedSeconds}s`);
    console.log(`[Job ${jobId}] Complete!`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Job ${jobId}] Failed: ${errorMessage}`);

    // IMPROVED: If we have partial results, mark as "partial" not "failed"
    if (checkpoints.length > 0) {
      await updateJob(supabase, jobId, {
        status: "failed",
        progress: Math.round((checkpoints.length / (checkpoints.length + 5)) * 100),
        error: `Partial failure: ${checkpoints.length} sections completed. Error: ${errorMessage}`,
      });
    } else {
      await updateJob(supabase, jobId, {
        status: "failed",
        error: errorMessage,
      });
    }
  }
}

// ========== PDF text preprocessing ==========

const CHAPTER_BREAK = "\n\n[CHAPTER_BREAK]\n\n";

/**
 * Clean up raw PDF text for better TTS output.
 * - Strips page numbers, headers/footers
 * - Fixes broken line breaks (mid-sentence wraps from PDF layout)
 * - Detects chapter/section boundaries and inserts markers
 * - Removes non-readable artifacts (URLs, footnote refs, table of contents)
 */
function preprocessPDFText(rawText: string, jobId: string): string {
  let text = rawText;
  const originalLength = text.length;

  // 1. Normalize Unicode: smart quotes, dashes, etc.
  text = text
    .replace(/[\u2018\u2019\u201A]/g, "'")   // Smart single quotes → apostrophe
    .replace(/[\u201C\u201D\u201E]/g, '"')   // Smart double quotes → straight
    .replace(/[\u2013\u2014]/g, " — ")       // En/em dashes with spacing
    .replace(/\u2026/g, "...")               // Ellipsis character
    .replace(/\u00A0/g, " ")                 // Non-breaking space
    .replace(/\uFEFF/g, "")                  // BOM
    .replace(/[\u200B-\u200D\u2060]/g, "");  // Zero-width chars

  // 2. Strip standalone page numbers (common PDF artifact)
  // Matches lines that are just a number, possibly with whitespace
  text = text.replace(/^\s*\d{1,4}\s*$/gm, "");

  // 3. Strip common headers/footers that repeat
  // Find lines that appear 3+ times (likely headers/footers)
  const lines = text.split("\n");
  const lineCounts = new Map<string, number>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 3 && trimmed.length < 100) {
      lineCounts.set(trimmed, (lineCounts.get(trimmed) || 0) + 1);
    }
  }
  const repeatedLines = new Set<string>();
  for (const [line, count] of lineCounts) {
    if (count >= 3) {
      repeatedLines.add(line);
    }
  }
  if (repeatedLines.size > 0) {
    text = lines
      .filter(line => !repeatedLines.has(line.trim()))
      .join("\n");
    console.log(`[Job ${jobId}] Stripped ${repeatedLines.size} repeated header/footer patterns`);
  }

  // 4. Detect chapter boundaries and insert markers
  // Common patterns: "Chapter 1", "CHAPTER ONE", "Part I", "1.", "I.", all-caps short lines
  text = text.replace(
    /\n\s*(?:(?:Chapter|CHAPTER|Part|PART|Section|SECTION)\s+[\dIVXLCDMivxlcdm]+[.:)?\s]*.*|(?:PROLOGUE|EPILOGUE|FOREWORD|PREFACE|INTRODUCTION|CONCLUSION|AFTERWORD|ACKNOWLEDGMENTS?))\s*\n/gi,
    (match) => `${CHAPTER_BREAK}${match.trim()}.\n\n`
  );
  // Also detect all-caps lines of 3-60 chars (likely section titles)
  text = text.replace(
    /\n\s*([A-Z][A-Z\s]{2,58}[A-Z])\s*\n/g,
    (match, title: string) => {
      // Only treat as chapter break if it looks like a title (not just shouting)
      const wordCount = title.trim().split(/\s+/).length;
      if (wordCount >= 1 && wordCount <= 8) {
        return `${CHAPTER_BREAK}${title.trim()}.\n\n`;
      }
      return match;
    }
  );

  // 5. Fix PDF line breaks: rejoin lines that were broken by page layout
  // A line ending with a lowercase letter followed by a line starting with
  // a lowercase letter is almost certainly a mid-sentence wrap
  text = text.replace(/([a-z,;:])\s*\n\s*([a-z])/g, "$1 $2");

  // Also fix hyphenated line breaks: "some-\nword" → "someword"
  text = text.replace(/(\w)-\s*\n\s*(\w)/g, "$1$2");

  // 6. Strip footnote references like [1], [2], superscript markers
  text = text.replace(/\[\d{1,3}\]/g, "");
  text = text.replace(/\{\d{1,3}\}/g, "");

  // 7. Strip URLs (not speakable)
  text = text.replace(/https?:\/\/[^\s)]+/g, "");
  text = text.replace(/www\.[^\s)]+/g, "");

  // 8. Strip email addresses
  text = text.replace(/[\w.-]+@[\w.-]+\.\w+/g, "");

  // 9. Collapse excessive whitespace but preserve paragraph breaks (double newlines)
  text = text.replace(/\n{3,}/g, "\n\n");  // Max 2 consecutive newlines
  text = text.replace(/[ \t]{2,}/g, " ");  // Collapse spaces/tabs
  text = text.replace(/^\s+$/gm, "");      // Remove whitespace-only lines

  // 10. Strip table of contents patterns ("Chapter 1 ......... 23")
  text = text.replace(/^.*\.{4,}\s*\d+\s*$/gm, "");

  // 11. Final trim
  text = text.trim();

  const removedChars = originalLength - text.length;
  const chapterBreaks = (text.match(/\[CHAPTER_BREAK\]/g) || []).length;
  console.log(`[Job ${jobId}] Preprocessing: removed ${removedChars} chars of artifacts, found ${chapterBreaks} chapter breaks`);

  return text;
}

// ========== Structure-aware text splitting ==========

interface TextSection {
  text: string;
  sentenceCount: number;
  startsChapter: boolean;
}

/**
 * Split text by sentences with structure awareness:
 * - Respects paragraph boundaries as preferred break points
 * - Forces breaks at chapter markers (inserts silence later)
 * - Never splits mid-sentence
 * - Target: ~600 chars per chunk (optimal for F5-TTS 30s limit)
 */
function splitBySentences(text: string, targetLength: number = 600): TextSection[] {
  // Split on chapter breaks first, then split each chapter into chunks
  const chapters = text.split(CHAPTER_BREAK).filter(c => c.trim());
  
  const allSections: TextSection[] = [];

  for (let chapterIdx = 0; chapterIdx < chapters.length; chapterIdx++) {
    const chapterText = chapters[chapterIdx]!.trim();
    if (!chapterText) continue;

    // Split chapter into paragraphs
    const paragraphs = chapterText.split(/\n\s*\n/).filter(p => p.trim());

    let currentText = "";
    let currentSentenceCount = 0;
    let isFirstInChapter = true;

    for (const paragraph of paragraphs) {
      // Split paragraph into sentences
      const sentences = splitIntoSentences(paragraph);

      for (const sentence of sentences) {
        const normalizedSentence = sentence.replace(/\s+/g, " ").trim();
        if (!normalizedSentence) continue;

        const projectedLength = currentText.length + normalizedSentence.length + (currentText ? 1 : 0);

        // Start new section if adding this sentence would exceed target
        if (currentSentenceCount > 0 && projectedLength > targetLength * 1.3) {
          allSections.push({
            text: currentText.trim(),
            sentenceCount: currentSentenceCount,
            startsChapter: isFirstInChapter,
          });
          isFirstInChapter = false;
          currentText = normalizedSentence;
          currentSentenceCount = 1;
        } else {
          currentText += (currentText ? " " : "") + normalizedSentence;
          currentSentenceCount++;
        }

        // Hard cap
        if (currentText.length > targetLength * 1.5) {
          allSections.push({
            text: currentText.trim(),
            sentenceCount: currentSentenceCount,
            startsChapter: isFirstInChapter,
          });
          isFirstInChapter = false;
          currentText = "";
          currentSentenceCount = 0;
        }
      }
    }

    // Flush remaining text for this chapter
    if (currentText.trim()) {
      allSections.push({
        text: currentText.trim(),
        sentenceCount: currentSentenceCount,
        startsChapter: isFirstInChapter,
      });
    }
  }

  const totalChars = allSections.reduce((a, s) => a + s.text.length, 0);
  const chapterStarts = allSections.filter(s => s.startsChapter).length;
  console.log(`[Text Split] Created ${allSections.length} sections from ${chapters.length} chapters`);
  console.log(`[Text Split] Average section length: ${Math.round(totalChars / (allSections.length || 1))} chars, ${chapterStarts} chapter starts`);

  return allSections;
}

/**
 * Split a paragraph into individual sentences with protection for
 * abbreviations, decimals, initials, and ellipses.
 */
function splitIntoSentences(text: string): string[] {
  // Protect special patterns
  const protectedText = text
    .replace(/(\d)\.(\d)/g, "$1<DOT>$2")
    .replace(
      /\b(Dr|Mr|Mrs|Ms|Prof|St|Ave|etc|i\.e|e\.g|vs|Vol|vol|Inc|Ltd|Jr|Sr|Mt|Gen|Gov|Sgt|Cpl|Rev|Hon|Capt|Col|Maj|Lt|Cmdr)\.?/gi,
      (match) => match.replace(".", "<DOT>")
    )
    .replace(/\.{3,}/g, "<ELLIPSIS>")
    .replace(/([A-Z]\.)+/g, (match) => match.replace(/\./g, "<DOT>"));

  const sentenceRegex = /[^.!?]+[.!?]+["']?\s*/g;
  const sentencesRaw = protectedText.match(sentenceRegex) || [protectedText];

  return sentencesRaw
    .map((s) => s.replace(/<DOT>/g, ".").replace(/<ELLIPSIS>/g, "...").trim())
    .filter((s) => s.length > 0);
}

// ========== Voice sample preparation ==========

interface ProcessedSample {
  buffer: Buffer;
  quality: number;
  duration: number;
}

async function prepareVoiceSamples(
  supabase: ReturnType<typeof getSupabase>,
  voiceStoragePaths: string[],
  videoId: string | null,
  startTime: number,
  endTime: number,
  jobId: string
): Promise<Buffer> {
  if (voiceStoragePaths.length === 0) {
    throw new Error("No voice samples provided. Upload audio or download from YouTube first.");
  }

  const processedSamples: ProcessedSample[] = [];
  
  // Process each voice sample
  for (const storagePath of voiceStoragePaths) {
    try {
      console.log(`[Job ${jobId}] Processing voice sample: ${storagePath}`);
      
      // Download voice sample
      const { data: voiceData, error } = await supabase.storage
        .from("audiobooks")
        .download(storagePath);

      if (error || !voiceData) {
        console.warn(`[Job ${jobId}] Failed to download voice ${storagePath}: ${error?.message}`);
        continue;
      }

      let voiceBuffer: Buffer = Buffer.from(await voiceData.arrayBuffer()) as Buffer;
      
      // Clip the audio to the user's selected time range
      const clipDuration = endTime - startTime;
      if (clipDuration < 3) {
        console.warn(`[Job ${jobId}] Voice clip too short: ${clipDuration}s, skipping`);
        continue;
      }
      
      voiceBuffer = await clipAudioBuffer(voiceBuffer, startTime, endTime);
      
      // Call the Audio Cleaner Modal to extract vocals FIRST
      // (Demucs isolates vocals from the full mix — run before EQ/enhancement)
      // Skip for direct uploads — they're already clean voice recordings, Demucs is slow
      const isUploaded = !videoId;
      const cleanerUrl = getEnv().MODAL_AUDIO_CLEANER_URL;
      if (cleanerUrl && !isUploaded) {
        try {
          const response = await fetch(cleanerUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              audio_base64: voiceBuffer.toString("base64"),
            }),
            signal: AbortSignal.timeout(300_000),
          });
          
          if (response.ok) {
            const result = await response.json();
            if (result.audio_base64) {
              voiceBuffer = Buffer.from(result.audio_base64, "base64");
            }
          }
        } catch (err) {
          console.warn(`[Job ${jobId}] Audio cleaner failed for sample, using raw clip:`, err);
        }
      }
      
      // Enhance the (now isolated) voice sample for better cloning quality
      // Gentle noise reduction + presence EQ + normalization
      // This preserves what makes the voice unique while cleaning up artifacts
      voiceBuffer = await enhanceVoiceSample(voiceBuffer, jobId);
      
      // Estimate quality based on duration and size
      const duration = endTime - startTime;
      const quality = estimateSampleQuality(voiceBuffer, duration);
      
      processedSamples.push({ buffer: voiceBuffer, quality, duration });
      
    } catch (err) {
      console.warn(`[Job ${jobId}] Failed to process sample ${storagePath}:`, err);
    }
  }

  if (processedSamples.length === 0) {
    throw new Error("No valid voice samples could be processed");
  }

  // Sort by quality and pick the best
  processedSamples.sort((a, b) => b.quality - a.quality);
  
  console.log(`[Job ${jobId}] Processed ${processedSamples.length} samples. Best quality: ${processedSamples[0]!.quality.toFixed(2)}`);
  
  // If we have multiple good samples, we could concatenate them
  // For now, return the best one (F5-TTS works best with a single clean sample)
  if (processedSamples.length === 1) {
    return processedSamples[0]!.buffer;
  }
  
  // For multiple samples, concatenate the top 2-3 for diversity
  const topSamples = processedSamples.slice(0, Math.min(3, processedSamples.length));
  if (topSamples.length > 1) {
    console.log(`[Job ${jobId}] Combining top ${topSamples.length} samples for diversity`);
    return concatenateSamples(topSamples.map(s => s.buffer));
  }
  
  return processedSamples[0]!.buffer;
}

function estimateSampleQuality(buffer: Buffer, duration: number): number {
  // Simple quality heuristic
  // In production, analyze RMS variance, spectral content, etc.
  let score = 1.0;
  
  // Penalize very short clips
  if (duration < 5) score *= 0.8;
  if (duration < 3) score *= 0.5;
  
  // Penalize very long clips (may have issues)
  if (duration > 30) score *= 0.9;
  
  // Size-based sanity check
  const sizeMB = buffer.length / (1024 * 1024);
  if (sizeMB < 0.1) score *= 0.7; // Suspiciously small
  if (sizeMB > 10) score *= 0.8; // Suspiciously large
  
  return score;
}

async function concatenateSamples(buffers: Buffer[]): Promise<Buffer> {
  // Simple concatenation with ffmpeg
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  
  const execAsync = promisify(exec);
  const tempDir = os.tmpdir();
  const files: string[] = [];
  let listFile = "";
  let outputPath = "";
  
  try {
    // Write all buffers to temp files
    for (let i = 0; i < buffers.length; i++) {
      const filePath = path.join(tempDir, `sample_${i}_${Date.now()}.wav`);
      fs.writeFileSync(filePath, buffers[i]!);
      files.push(filePath);
    }
    
    // Create concat list
    listFile = path.join(tempDir, `list_${Date.now()}.txt`);
    const listContent = files.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(listFile, listContent);
    
    // Concatenate with re-encoding (not -c copy, which fails with mixed formats)
    outputPath = path.join(tempDir, `combined_${Date.now()}.wav`);
    await execAsync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -ac 1 -ar 24000 "${outputPath}"`);
    
    return fs.readFileSync(outputPath) as Buffer;
    
  } finally {
    // Cleanup
    for (const f of files) {
      try { fs.unlinkSync(f); } catch {}
    }
    if (listFile) try { fs.unlinkSync(listFile); } catch {}
    if (outputPath) try { fs.unlinkSync(outputPath); } catch {}
  }
}

async function normalizeAudio(buffer: Buffer): Promise<Buffer> {
  // Normalize to -23 LUFS (broadcast standard) using ffmpeg
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  
  const execAsync = promisify(exec);
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `norm_in_${Date.now()}.wav`);
  const outputPath = path.join(tempDir, `norm_out_${Date.now()}.wav`);
  
  try {
    fs.writeFileSync(inputPath, buffer);
    await execAsync(`ffmpeg -y -i "${inputPath}" -af "loudnorm=I=-23:LRA=7:TP=-2" "${outputPath}"`);
    return fs.readFileSync(outputPath) as Buffer;
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

// ========== Voice sample preprocessing ==========

async function enhanceVoiceSample(buffer: Buffer, jobId: string): Promise<Buffer> {
  // Enhance voice sample for better TTS cloning WITHOUT stripping character.
  // Key principle: preserve formants (1-4kHz) and vocal texture — only remove
  // what's clearly NOT the voice (sub-bass rumble, extreme hiss, background noise).
  //
  // Pipeline:
  //   1. High-pass at 80Hz — removes rumble/hum without touching voice fundamentals
  //   2. Gentle noise reduction (ffmpeg anlmdn) — reduces background noise by ~6dB
  //      without the aggressive artifacts of spectral gating
  //   3. Presence boost +2dB at 3kHz — makes phonemes clearer for Whisper transcription
  //      and F5-TTS phoneme alignment (better ref_text = better cloning)
  //   4. De-ess -3dB at 6kHz — tames harsh sibilants that cause TTS distortion
  //   5. Loudnorm to -16 LUFS — consistent volume for the TTS model
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  
  const execAsync = promisify(exec);
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `voice_enhance_in_${Date.now()}.wav`);
  const outputPath = path.join(tempDir, `voice_enhance_out_${Date.now()}.wav`);
  
  try {
    fs.writeFileSync(inputPath, buffer);
    
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" -ar 24000 -ac 1 ` +
      `-af "highpass=f=80,` +
      `anlmdn=s=7:p=0.07:r=0.04:m=15,` +
      `equalizer=f=3000:t=q:w=2:g=1,` +
      `equalizer=f=6000:t=q:w=1.5:g=-1,` +
      `loudnorm=I=-16:LRA=11:TP=-1.5" ` +
      `"${outputPath}"`;
    
    await execAsync(ffmpegCmd);
    
    const result = fs.readFileSync(outputPath) as Buffer;
    console.log(`[Job ${jobId}] Voice sample enhanced: ${buffer.length} → ${result.length} bytes`);
    return result;
    
  } catch (err) {
    // Fallback to simple normalize if enhancement fails
    console.warn(`[Job ${jobId}] Voice enhancement failed, falling back to normalize:`, err);
    return normalizeAudio(buffer);
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

// ========== Post-processing: Fix the "wiretap" sound ==========

async function postProcessAudio(audioBuffer: Buffer, jobId: string): Promise<Buffer> {
  // Transform 24kHz TTS output into professional audiobook quality:
  // 1. Upsample 24kHz → 44.1kHz (frequencies above 12kHz become audible)
  // 2. Apply audiobook EQ curve:
  //    - Warmth: +2dB at 200Hz (richer, less thin)
  //    - Presence: +3dB at 3kHz (clarity, intelligibility)
  //    - Air: +2dB shelf at 12kHz (breathy, natural — removes "phone call" muffle)
  //    - Remove mud: -2dB at 400Hz (cleaner midrange)
  // 3. Global loudnorm to -16 LUFS (ACX/audiobook standard, consistent volume)
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  
  const execAsync = promisify(exec);
  const tempDir = path.join(os.tmpdir(), `echomancer_post_${jobId}`);
  
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const inputPath = path.join(tempDir, "input.mp3");
  const outputPath = path.join(tempDir, "output.mp3");
  
  try {
    fs.writeFileSync(inputPath, audioBuffer);
    
    // Single-pass ffmpeg: resample + EQ + loudnorm
    // Gentle audiobook EQ — avoid harsh high-frequency boosts that cause piercing sound
    // The 24kHz TTS source has no real content above 12kHz, so don't boost there
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" ` +
      `-ar 44100 -ac 1 ` +
      `-af "equalizer=f=200:t=q:w=1.5:g=1.5,` +
      `equalizer=f=400:t=q:w=1.5:g=-1,` +
      `equalizer=f=3000:t=q:w=2:g=1,` +
      `lowpass=f=11000,` +
      `loudnorm=I=-16:LRA=11:TP=-1.5" ` +
      `-b:a 192k "${outputPath}"`;
    
    console.log(`[Job ${jobId}] Running post-processing pipeline...`);
    await execAsync(ffmpegCmd, { maxBuffer: 100 * 1024 * 1024 });
    
    const result = fs.readFileSync(outputPath) as Buffer;
    console.log(`[Job ${jobId}] Post-processing complete: ${audioBuffer.length} → ${result.length} bytes (upsampled + EQ + loudnorm)`);
    return result;
    
  } catch (err) {
    // If full pipeline fails, try simple upsample + loudnorm (no EQ)
    console.warn(`[Job ${jobId}] Full post-processing failed, trying simple upsample:`, err);
    try {
      const fallbackCmd = `ffmpeg -y -i "${inputPath}" -ar 44100 -ac 1 -af "loudnorm=I=-16:LRA=11:TP=-1.5" -b:a 192k "${outputPath}"`;
      await execAsync(fallbackCmd, { maxBuffer: 100 * 1024 * 1024 });
      return fs.readFileSync(outputPath) as Buffer;
    } catch (fallbackErr) {
      // If even simple upsample fails, return original (better than crashing)
      console.warn(`[Job ${jobId}] Post-processing failed entirely, using raw output`);
      return audioBuffer;
    }
  } finally {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

async function clipAudioBuffer(audioBuffer: Buffer, startTime: number, endTime: number): Promise<Buffer> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  
  const execAsync = promisify(exec);
  
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `input_${Date.now()}.audio`);
  const outputPath = path.join(tempDir, `clipped_${Date.now()}.wav`);
  
  try {
    fs.writeFileSync(inputPath, audioBuffer);
    const duration = endTime - startTime;
    
    // Use ffmpeg to clip - mono, 24kHz for F5-TTS
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" -ss ${startTime} -t ${duration} -ac 1 -ar 24000 "${outputPath}"`;
    
    await execAsync(ffmpegCmd);
    
    return fs.readFileSync(outputPath) as Buffer;
  } finally {
    try {
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ========== Emotion Director: Get per-chunk speeds ==========

interface EmotionDirection {
  speed: number;
  modifiedText: string;
}

async function getEmotionDirections(
  texts: string[],
  jobId: string
): Promise<EmotionDirection[] | undefined> {
  const directorUrl = getEnv().MODAL_LLM_DIRECTOR_URL;
  if (!directorUrl) return undefined;
  
  // Skip if all texts are short — emotion pacing won't vary much on short passages
  const avgLen = texts.reduce((s, t) => s + t.length, 0) / texts.length;
  if (avgLen < 100) {
    console.log(`[Job ${jobId}] Emotion Director: skipping (avg text length ${Math.round(avgLen)} too short)`);
    return undefined;
  }
  
  try {
    // Call Emotion Director sequentially (max 2 concurrent) to avoid
    // spinning up multiple Modal GPU containers from parallel requests
    const results: EmotionDirection[] = [];
    const CONCURRENCY = 2;
    for (let i = 0; i < texts.length; i += CONCURRENCY) {
      const batch = texts.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (text) => {
          try {
            const response = await fetch(directorUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: text.slice(0, 512) }),
              signal: AbortSignal.timeout(15_000),
            });

            if (!response.ok) return { speed: 1.0, modifiedText: text };
            const result = await response.json();
            if (result.error) return { speed: 1.0, modifiedText: text };
            // Clamp speed to safe range — F5-TTS produces garbage outside ~0.7-1.3
            const rawSpeed = Number(result.speed) || 1.0;
            const speed = Math.max(0.7, Math.min(1.3, rawSpeed));
            // Use modified_text with SML tags (pauses, emotion markers) if available
            const modifiedText = result.modified_text || text;
            return { speed, modifiedText };
          } catch {
            return { speed: 1.0, modifiedText: text };
          }
        })
      );
      results.push(...batchResults);
    }
    
    const nonDefault = results.filter(r => Math.abs(r.speed - 1.0) > 0.01).length;
    const hasMarkup = results.filter(r => r.modifiedText !== texts[results.indexOf(r)]).length;
    console.log(`[Job ${jobId}] Emotion Director: ${nonDefault}/${texts.length} non-default speeds, ${hasMarkup} with SML markup`);
    return results;
  } catch (err) {
    console.warn(`[Job ${jobId}] Emotion Director unavailable, using uniform speed:`, err);
    return undefined;
  }
}

// ========== Batch TTS: Send multiple texts in one request ==========

async function modalTTSBatch(
  batchUrl: string,
  texts: string[],
  voiceBase64: string,
  jobId: string,
  speeds?: number[],
): Promise<Array<{ audio_base64: string; size: number; error?: string }>> {
  return new Promise((resolve, reject) => {
    try {
      const payload = JSON.stringify({
        texts,
        reference_audio_base64: voiceBase64,
        format: "mp3",
        speed: 1.0,
        jitter: 0.03,
        context_seconds: 2.0,
        ...(speeds ? { speeds } : {}),
      });

      console.log(`[Job ${jobId}] Sending batch of ${texts.length} texts (payload: ${(Buffer.byteLength(payload) / 1024 / 1024).toFixed(1)}MB)`);

      const urlObj = new URL(batchUrl);
      const isHttps = urlObj.protocol === "https:";
      const requestModule = isHttps ? https : http;

      const options = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 20 * 60 * 1000, // 20 min for batch
      };

      const req = requestModule.request(urlObj, options, (res) => {
        const chunks: Buffer[] = [];
        
        res.on("data", (chunk) => chunks.push(chunk));
        
        res.on("end", () => {
          const responseBuffer = Buffer.concat(chunks);
          const responseText = responseBuffer.toString('utf-8');

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Modal batch TTS failed (${res.statusCode}): ${responseText.slice(0, 500)}`));
          }

          try {
            const result = JSON.parse(responseText);
            if (result.error) {
              return reject(new Error(`Modal batch TTS error: ${result.error}`));
            }
            if (!result.results || !Array.isArray(result.results)) {
              return reject(new Error("Modal batch TTS returned no results array"));
            }
            resolve(result.results);
          } catch (e) {
            reject(new Error(`Failed to parse Modal batch response: ${e}`));
          }
        });
      });

      req.on("error", (err) => {
        reject(new Error(`Network error during Modal batch request: ${err.message}`));
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Modal batch TTS request timed out after 20 minutes"));
      });

      req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ========== Fast checkpoint validation via storage.list ==========

async function validateCheckpointsFast(
  supabase: ReturnType<typeof getSupabase>,
  checkpoints: ProgressCheckpoint[],
  jobId: string
): Promise<ProgressCheckpoint[]> {
  try {
    // List all files in the chunks directory — single API call
    const { data: files, error } = await supabase.storage
      .from("audiobooks")
      .list(`chunks/${jobId}`, { limit: 5000 });

    if (error) {
      console.warn(`[Job ${jobId}] Fast validation failed, falling back: ${error.message}`);
      // Fallback: trust checkpoint metadata
      return checkpoints;
    }

    const existingFiles = new Set((files || []).map(f => f.name));
    const validCheckpoints: ProgressCheckpoint[] = [];
    const missingIndices: number[] = [];

    for (const checkpoint of checkpoints) {
      // Extract filename from full path: "chunks/{jobId}/section_0001.mp3" → "section_0001.mp3"
      const fileName = checkpoint.audioPath.split('/').pop() || '';
      if (existingFiles.has(fileName)) {
        validCheckpoints.push(checkpoint);
      } else {
        missingIndices.push(checkpoint.sectionIndex);
      }
    }

    if (missingIndices.length > 0) {
      console.warn(`[Job ${jobId}] Missing sections: ${missingIndices.join(', ')}`);
    }

    return validCheckpoints;
  } catch {
    // If listing fails entirely, trust checkpoint metadata
    return checkpoints;
  }
}

// ========== Concatenation with crossfade — streams from Supabase ==========

async function concatenateFromBuffers(
  supabase: ReturnType<typeof getSupabase>,
  checkpoints: ProgressCheckpoint[],
  audioBuffers: Map<number, Buffer>,
  jobId: string
): Promise<Buffer> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");

  const execAsync = promisify(exec);
  const tempDir = path.join(os.tmpdir(), `echomancer_${jobId}`);

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  try {
    const audioFiles: string[] = [];

    for (let i = 0; i < checkpoints.length; i++) {
      const checkpoint = checkpoints[i];
      if (!checkpoint) continue;

      // Use in-memory buffer if still available, otherwise download from Supabase
      let buffer = audioBuffers.get(checkpoint.sectionIndex);
      if (!buffer) {
        const { data, error: dlError } = await supabase.storage
          .from("audiobooks")
          .download(checkpoint.audioPath);

        if (dlError || !data) {
          console.warn(`[Job ${jobId}] Skipping section ${checkpoint.sectionIndex}: ${dlError?.message}`);
          continue;
        }
        buffer = Buffer.from(await data.arrayBuffer());
      }

      const filePath = path.join(tempDir, `section_${String(i).padStart(4, '0')}.mp3`);
      fs.writeFileSync(filePath, buffer);
      audioFiles.push(filePath);
    }
    
    if (audioFiles.length === 0) {
      throw new Error("No audio files to concatenate");
    }
    
    if (audioFiles.length === 1) {
      return fs.readFileSync(audioFiles[0]!) as Buffer;
    }
    
    const outputPath = path.join(tempDir, 'output.mp3');
    
    // Real crossfade concatenation using acrossfade filter chain
    // Decode all to PCM, apply 150ms crossfades between adjacent chunks, re-encode
    // For large section counts (>20), skip crossfade and use concat directly —
    // chained acrossfade filters hit ffmpeg's complexity limit with many inputs
    const CROSSFADE_LIMIT = 20;
    
    if (audioFiles.length === 2) {
      // Simple case: two files with acrossfade
      const ffmpegCmd = `ffmpeg -y -i "${audioFiles[0]}" -i "${audioFiles[1]}" -filter_complex "acrossfade=d=0.15:c1=tri:c2=tri" -b:a 192k "${outputPath}"`;
      await execAsync(ffmpegCmd);
    } else if (audioFiles.length <= CROSSFADE_LIMIT) {
      // Multiple files: chain acrossfade filters
      // For N files we need N-1 acrossfade operations
      // Build a filter chain: [0][1]acrossfade=d=0.15[a01]; [a01][2]acrossfade=d=0.15[a02]; ...
      const inputs = audioFiles.map(f => `-i "${f}"`).join(' ');
      let filterParts: string[] = [];
      let prevLabel = "0:a";
      
      for (let i = 1; i < audioFiles.length; i++) {
        const outLabel = i === audioFiles.length - 1 ? "outa" : `a${String(i).padStart(2, '0')}`;
        filterParts.push(`[${prevLabel}][${i}:a]acrossfade=d=0.15:c1=tri:c2=tri[${outLabel}]`);
        prevLabel = outLabel;
      }
      
      const filterStr = filterParts.join('; ');
      const ffmpegCmd = `ffmpeg -y ${inputs} -filter_complex "${filterStr}" -map "[outa]" -b:a 192k "${outputPath}"`;
      
      try {
        await execAsync(ffmpegCmd, { maxBuffer: 50 * 1024 * 1024 });
      } catch (crossfadeErr) {
        // Fallback to simple concat filter if acrossfade chain fails
        console.warn(`[Job ${jobId}] Crossfade chain failed, falling back to concat filter`);
        const filterInputs = audioFiles.map((_, i) => `[${i}:a]`).join('');
        const concatFilter = `${filterInputs}concat=n=${audioFiles.length}:v=0:a=1[outa]`;
        const fallbackCmd = `ffmpeg -y ${inputs} -filter_complex "${concatFilter}" -map "[outa]" -b:a 192k "${outputPath}"`;
        await execAsync(fallbackCmd, { maxBuffer: 50 * 1024 * 1024 });
      }
    } else {
      // Too many files for crossfade chain — use concat filter directly
      console.log(`[Job ${jobId}] ${audioFiles.length} sections, using concat filter (skipping crossfade for performance)`);
      const inputs = audioFiles.map(f => `-i "${f}"`).join(' ');
      const filterInputs = audioFiles.map((_, i) => `[${i}:a]`).join('');
      const concatFilter = `${filterInputs}concat=n=${audioFiles.length}:v=0:a=1[outa]`;
      const ffmpegCmd = `ffmpeg -y ${inputs} -filter_complex "${concatFilter}" -map "[outa]" -b:a 192k "${outputPath}"`;
      await execAsync(ffmpegCmd, { maxBuffer: 50 * 1024 * 1024 });
    }
    
    return fs.readFileSync(outputPath) as Buffer;
    
  } finally {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ========== Checkpoint persistence ==========

async function loadCheckpoints(
  supabase: ReturnType<typeof getSupabase>,
  jobId: string
): Promise<ProgressCheckpoint[]> {
  try {
    const { data, error } = await supabase
      .from("job_checkpoints")
      .select("*")
      .eq("job_id", jobId)
      .order("section_index", { ascending: true });
    
    if (error) {
      console.warn(`[loadCheckpoints] Skipping resume: ${error.message}`);
      return [];
    }
    
    return (data || []).map((row: { section_index: number; audio_path: string; created_at: string }) => ({
      sectionIndex: row.section_index,
      audioPath: row.audio_path,
      timestamp: row.created_at,
      textLength: 0,
    }));
  } catch {
    return [];
  }
}

async function saveCheckpoints(
  supabase: ReturnType<typeof getSupabase>,
  jobId: string,
  checkpoints: ProgressCheckpoint[]
): Promise<void> {
  try {
    const rows = checkpoints.map(c => ({
      job_id: jobId,
      section_index: c.sectionIndex,
      audio_path: c.audioPath,
    }));
    
    const { error } = await supabase.from("job_checkpoints").upsert(rows, {
      onConflict: "job_id,section_index",
    });
    
    if (error) {
      console.warn(`[saveCheckpoints] Failed: ${error.message}`);
    }
  } catch {
    // Non-critical
  }
}

// ========== Helpers ==========

async function extractDocumentText(supabase: ReturnType<typeof getSupabase>, storagePath: string): Promise<string> {
  const { data: fileData, error } = await supabase.storage
    .from("audiobooks")
    .download(storagePath);

  if (error || !fileData) {
    throw new Error(`Failed to download document: ${error?.message}`);
  }

  const fileBuffer = Buffer.from(await fileData.arrayBuffer());
  const { extractTextFromDocument } = await import("@/lib/text-extraction");
  
  // Extract filename from storage path for format detection
  const fileName = storagePath.split("/").pop() || "unknown.txt";
  const text = await extractTextFromDocument(fileBuffer, fileName);
  
  if (!text?.trim()) {
    throw new Error("Could not extract text from document. Is it a scanned document or DRM-protected?");
  }
  
  return text;
}

async function updateJob(
  supabase: ReturnType<typeof getSupabase>,
  jobId: string,
  updates: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from("jobs")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", jobId);

  if (error) {
    console.warn(`[Job ${jobId}] Failed to update status:`, error.message);
  }
}
