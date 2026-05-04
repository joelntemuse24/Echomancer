/**
 * F5-TTS Modal Audiobook Generator for Echomancer
 * 
 * Optimizations:
 * - Batch processing with shared reference audio for voice consistency
 * - Checkpoint-based resume capability
 * - Crossfade concatenation for smooth transitions
 * - Proper audio format handling (24kHz from F5-TTS)
 */

import https from "https";
import { getEnv } from "@/lib/env";
import { updateJob } from "@/lib/db/jobs";
import { db } from "@/lib/db";
import { downloadFile, uploadFile, fileExists } from "@/lib/storage";

// Global AbortController registry
const activeJobs = new Map<string, AbortController>();

export function cancelJobGeneration(jobId: string): boolean {
  const controller = activeJobs.get(jobId);
  if (controller) {
    controller.abort();
    activeJobs.delete(jobId);
    return true;
  }
  return false;
}

interface GenerateParams {
  jobId: string;
  pdfStoragePath: string;
  voiceStoragePath: string | null;
  voiceStoragePaths?: string[];
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

// F5-TTS specific settings for optimal quality/speed
const F5_TTS_CONFIG = {
  // NFE steps: lower = faster, 32 = good quality/speed balance
  // Use 16 for faster generation, 32 for better quality
  NFE_STEP: 32,
  // CFG strength: 2.0 is default, higher = more adherence to reference
  CFG_STRENGTH: 2.0,
  // Speed: 1.0 = normal, <1 = slower (more natural), >1 = faster
  SPEED: 1.0,
  // Target sample rate for F5-TTS output
  SAMPLE_RATE: 24000,
  // Batch size for Modal processing - balance speed vs consistency
  BATCH_SIZE: 8,
  // Max chunk size in characters (F5-TTS handles longer texts well)
  MAX_CHUNK_SIZE: 1200,
};

export async function generateAudiobookF5Modal(params: GenerateParams) {
  const { jobId, pdfStoragePath, voiceStoragePath, voiceStoragePaths, videoId, startTime, endTime } = params;
  
  const env = getEnv();
  
  // Get Modal URL from environment
  const modalTtsUrl = process.env.MODAL_TTS_URL;
  if (!modalTtsUrl) {
    updateJob(jobId, { 
      status: "failed", 
      error_message: "F5-TTS Modal not configured. Set MODAL_TTS_URL in .env.local" 
    });
    return;
  }

  // Register AbortController
  const abortController = new AbortController();
  activeJobs.set(jobId, abortController);
  const signal = abortController.signal;

  const checkpoints: ProgressCheckpoint[] = [];
  const jobStartTime = Date.now();

  try {
    updateJob(jobId, { status: "processing", progress: 5 });

    // Step 1: Download & extract PDF
    const rawText = await extractDocumentText(pdfStoragePath);
    console.log(`[Job ${jobId}] Extracted ${rawText.length} characters (raw)`);
    
    const text = preprocessPDFText(rawText, jobId);
    console.log(`[Job ${jobId}] Preprocessed to ${text.length} characters`);
    updateJob(jobId, { progress: 10 });

    // Step 2: Prepare voice sample
    const voicePaths = voiceStoragePaths && voiceStoragePaths.length > 0 
      ? voiceStoragePaths 
      : voiceStoragePath 
        ? [voiceStoragePath] 
        : [];
    
    if (voicePaths.length === 0) {
      throw new Error("No voice samples provided");
    }
    
    const { buffer: voiceSample } = await prepareVoiceSamples(
      voicePaths,
      videoId,
      startTime,
      endTime,
      jobId
    );
    console.log(`[Job ${jobId}] Voice sample ready (${voiceSample.length} bytes)`);
    updateJob(jobId, { progress: 15 });

    // Save clipped voice to storage for reference
    const voiceClipPath = `voices/${jobId}/voice_clip.wav`;
    await uploadFile("voices/" + jobId, "voice_clip.wav", voiceSample, "audio/wav");

    // Step 3: Text splitting
    const sections = splitBySentences(text, F5_TTS_CONFIG.MAX_CHUNK_SIZE);
    console.log(`[Job ${jobId}] Split into ${sections.length} sentence-based sections`);
    
    const totalChars = sections.reduce((s, sec) => s + sec.text.length, 0);
    // Estimate: ~150 chars/sec at speed 1.0, but F5-TTS is faster
    const estimatedSeconds = Math.round(totalChars / 15);  // ~15 chars/sec
    console.log(`[Job ${jobId}] ⏱ Estimate: ${totalChars} chars, ${sections.length} sections → ~${Math.round(estimatedSeconds/60)}m${estimatedSeconds%60}s`);
    updateJob(jobId, { progress: 20, total_sections: sections.length });

    // Check for existing checkpoints
    const existingCheckpoints = await loadCheckpoints(jobId);
    if (existingCheckpoints.length > 0) {
      console.log(`[Job ${jobId}] Resuming from checkpoint, ${existingCheckpoints.length} sections done`);
      checkpoints.push(...existingCheckpoints);
    }

    // Step 4: Generate audio in batches
    const totalSections = sections.length;
    const audioBuffers: Map<number, Buffer> = new Map();

    console.log(`[Job ${jobId}] Using F5-TTS on Modal (batch size: ${F5_TTS_CONFIG.BATCH_SIZE})`);

    // Build list of pending sections
    const pendingIndices: number[] = [];
    const pendingTexts: string[] = [];
    for (let i = 0; i < totalSections; i++) {
      const section = sections[i];
      if (!section) continue;
      if (checkpoints.some(c => c.sectionIndex === i)) continue;
      pendingIndices.push(i);
      pendingTexts.push(section.text);
    }

    if (signal.aborted) {
      updateJob(jobId, { status: "failed", error_message: "Cancelled by user" });
      activeJobs.delete(jobId);
      return;
    }

    // Process in batches
    const batches: { indices: number[]; texts: string[] }[] = [];
    for (let i = 0; i < pendingTexts.length; i += F5_TTS_CONFIG.BATCH_SIZE) {
      batches.push({
        indices: pendingIndices.slice(i, i + F5_TTS_CONFIG.BATCH_SIZE),
        texts: pendingTexts.slice(i, i + F5_TTS_CONFIG.BATCH_SIZE),
      });
    }

    console.log(`[Job ${jobId}] Processing ${pendingTexts.length} sections in ${batches.length} batches`);
    const allStartTime = Date.now();
    let completedCount = 0;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      if (!batch) continue;
      
      if (signal.aborted) {
        throw new Error("Cancelled");
      }

      console.log(`[Job ${jobId}] Batch ${batchIdx + 1}/${batches.length}: ${batch.texts.length} sections`);
      
      const batchResults = await f5TTSBatchGenerate(
        modalTtsUrl,
        voiceSample,
        batch.texts,
        jobId,
        signal
      );

      // Process results
      for (let r = 0; r < batchResults.length; r++) {
        const result = batchResults[r];
        const sectionIndex = batch.indices[r];
        
        if (!result || sectionIndex === undefined) continue;
        
        if (result.error || !result.audio_buffer) {
          console.warn(`[Job ${jobId}] Section ${sectionIndex + 1} failed: ${result.error || "No audio"}`);
          continue;
        }
        
        audioBuffers.set(sectionIndex, Buffer.from(result.audio_buffer));
        checkpoints.push({
          sectionIndex,
          audioPath: `checkpoints/${jobId}/section_${String(sectionIndex).padStart(4, '0')}.wav`,
          timestamp: new Date().toISOString(),
          textLength: batch.texts[r]?.length ?? 0,
        });
      }

      completedCount += batch.texts.length;
      const progress = 20 + Math.round((completedCount / totalSections) * 60);
      console.log(`[Job ${jobId}] Progress: ${completedCount}/${totalSections} sections (${progress}%)`);
      updateJob(jobId, { progress, current_section: completedCount });
    }

    const allElapsed = ((Date.now() - allStartTime) / 1000).toFixed(1);
    console.log(`[Job ${jobId}] ⏱ All sections done in ${allElapsed}s`);

    // Save checkpoints
    const existingIndices = new Set(existingCheckpoints.map(c => c.sectionIndex));
    for (const cp of checkpoints) {
      if (existingIndices.has(cp.sectionIndex)) continue;
      const buf = audioBuffers.get(cp.sectionIndex);
      if (!buf) continue;
      await uploadFile(`checkpoints/${jobId}`, `section_${String(cp.sectionIndex).padStart(4, '0')}.wav`, buf, "audio/wav");
    }
    await saveCheckpoints(jobId, checkpoints);
    console.log(`[Job ${jobId}] Checkpoints saved (${checkpoints.length} sections)`);

    updateJob(jobId, { progress: 85 });

    // Step 5: Validate checkpoints
    if (checkpoints.length === 0) {
      throw new Error("No audio sections were successfully generated.");
    }

    const sortedCheckpoints = [...checkpoints].sort((a, b) => a.sectionIndex - b.sectionIndex);
    const validCheckpoints = sortedCheckpoints.filter(cp => audioBuffers.has(cp.sectionIndex));

    if (validCheckpoints.length === 0) {
      throw new Error("No valid audio files found.");
    }

    console.log(`[Job ${jobId}] ${validCheckpoints.length} valid checkpoints.`);

    // Step 6: Concatenate with crossfade
    console.log(`[Job ${jobId}] Concatenating ${validCheckpoints.length} sections...`);
    let concatenatedAudio: Buffer = await concatenateFromBuffers(validCheckpoints, audioBuffers, jobId);

    // Step 7: Post-processing (minimal for F5-TTS 24kHz)
    console.log(`[Job ${jobId}] Post-processing: gentle normalization at 24kHz...`);
    concatenatedAudio = await postProcessAudio(concatenatedAudio, jobId);

    updateJob(jobId, { progress: 95 });

    // Upload final audiobook
    const outputPath = `audiobooks/${jobId}/audiobook.mp3`;
    await uploadFile(`audiobooks/${jobId}`, "audiobook.mp3", concatenatedAudio, "audio/mpeg");

    updateJob(jobId, {
      status: "ready",
      progress: 100,
      audio_storage_path: outputPath,
      error_message: null,
    });

    const totalElapsed = ((Date.now() - jobStartTime) / 1000).toFixed(1);
    console.log(`[Job ${jobId}] ⏱ Complete in ${totalElapsed}s`);
    console.log(`[Job ${jobId}] Complete!`);
    activeJobs.delete(jobId);

  } catch (error) {
    const isCancelled = 
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.message === "Cancelled");
    
    if (isCancelled) {
      console.log(`[Job ${jobId}] Generation aborted by cancel`);
      updateJob(jobId, { status: "failed", error_message: "Cancelled by user" });
      activeJobs.delete(jobId);
      return;
    }
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Job ${jobId}] Failed: ${errorMessage}`);

    if (checkpoints.length > 0) {
      updateJob(jobId, {
        status: "failed",
        progress: Math.round((checkpoints.length / (checkpoints.length + 5)) * 100),
        error_message: `Partial failure: ${checkpoints.length} sections completed. Error: ${errorMessage}`,
      });
    } else {
      updateJob(jobId, {
        status: "failed",
        error_message: errorMessage,
      });
    }
    activeJobs.delete(jobId);
  }
}

// F5-TTS Batch Generation via Modal
async function f5TTSBatchGenerate(
  modalUrl: string,
  voiceBuffer: Buffer,
  texts: string[],
  jobId: string,
  signal?: AbortSignal
): Promise<Array<{ audio_buffer?: ArrayBuffer; error?: string }>> {
  
  const voiceBase64 = voiceBuffer.toString("base64");
  
  const requestBody = JSON.stringify({
    texts,
    reference_audio_base64: voiceBase64,
    nfe_step: F5_TTS_CONFIG.NFE_STEP,
    cfg_strength: F5_TTS_CONFIG.CFG_STRENGTH,
    speed: F5_TTS_CONFIG.SPEED,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(modalUrl);
    
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(requestBody),
      },
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf-8");
        
        try {
          const response = JSON.parse(responseBody);
          
          if (response.error) {
            reject(new Error(`F5-TTS error: ${response.error}`));
            return;
          }
          
          // Parse batch results
          const results = response.results || [];
          const parsed = results.map((r: { audio_base64?: string; error?: string }) => ({
            audio_buffer: r.audio_base64 ? Buffer.from(r.audio_base64, "base64") : undefined,
            error: r.error,
          }));
          
          resolve(parsed);
          
        } catch (e) {
          reject(new Error(`Failed to parse F5-TTS response: ${responseBody.slice(0, 200)}`));
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`F5-TTS request failed: ${err.message}`));
    });

    // Handle abort signal
    if (signal) {
      signal.addEventListener("abort", () => {
        req.destroy();
        reject(new Error("Cancelled"));
      });
    }

    req.write(requestBody);
    req.end();
  });
}

// PDF preprocessing
const CHAPTER_BREAK = "\n\n[CHAPTER_BREAK]\n\n";

function preprocessPDFText(rawText: string, jobId: string): string {
  let text = rawText;
  const originalLength = text.length;

  text = text
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2013\u2014]/g, " — ")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/\uFEFF/g, "")
    .replace(/[\u200B-\u200D\u2060]/g, "");

  text = text.replace(/^\s*\d{1,4}\s*$/gm, "");

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
    if (count >= 3) repeatedLines.add(line);
  }
  if (repeatedLines.size > 0) {
    text = lines.filter(line => !repeatedLines.has(line.trim())).join("\n");
    console.log(`[Job ${jobId}] Stripped ${repeatedLines.size} repeated header/footer patterns`);
  }

  text = text.replace(
    /\n\s*(?:(?:Chapter|CHAPTER|Part|PART|Section|SECTION)\s+[\dIVXLCDMivxlcdm]+[.:)?\s]*.*|(?:PROLOGUE|EPILOGUE|FOREWORD|PREFACE|INTRODUCTION|CONCLUSION|AFTERWORD|ACKNOWLEDGMENTS?))\s*\n/gi,
    (match) => {
      const title = match.trim().replace(/\.$/, "");
      const spoken = title.replace(/\b(CHAPTER|PART|SECTION|PROLOGUE|EPILOGUE|FOREWORD|PREFACE|INTRODUCTION|CONCLUSION|AFTERWORD|ACKNOWLEDGMENTS?)\b/g,
        (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      );
      return `${CHAPTER_BREAK}${spoken}.\n\n`;
    }
  );

  text = text.replace(
    /\n\s*([A-Z][A-Z\s]{2,58}[A-Z])\s*\n/g,
    (match, title: string) => {
      const wordCount = title.trim().split(/\s+/).length;
      if (wordCount >= 1 && wordCount <= 8) {
        const spoken = title.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
        return `${CHAPTER_BREAK}${spoken}.\n\n`;
      }
      return match;
    }
  );

  text = text.replace(/([a-z,;:])\s*\n\s*([a-z])/g, "$1 $2");
  text = text.replace(/(\w)-\s*\n\s*(\w)/g, "$1$2");
  text = text.replace(/\[\d{1,3}\]/g, "");
  text = text.replace(/\{\d{1,3}\}/g, "");
  text = text.replace(/https?:\/\/[^\s)]+/g, "");
  text = text.replace(/www\.[^\s)]+/g, "");
  text = text.replace(/[\w.-]+@[\w.-]+\.\w+/g, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/^\s+$/gm, "");
  text = text.replace(/^.*\.{4,}\s*\d+\s*$/gm, "");
  text = text.trim();

  const removedChars = originalLength - text.length;
  const chapterBreaks = (text.match(/\[CHAPTER_BREAK\]/g) || []).length;
  console.log(`[Job ${jobId}] Preprocessing: removed ${removedChars} chars of artifacts, found ${chapterBreaks} chapter breaks`);

  return text;
}

// Text splitting
interface TextSection {
  text: string;
  sentenceCount: number;
  startsChapter: boolean;
}

function splitBySentences(text: string, targetLength: number = 1000): TextSection[] {
  const chapters = text.split(CHAPTER_BREAK).filter(c => c.trim());
  const allSections: TextSection[] = [];

  for (const chapterText of chapters) {
    const paragraphs = chapterText.trim().split(/\n\s*\n/).filter(p => p.trim());
    let currentText = "";
    let currentSentenceCount = 0;
    let isFirstInChapter = true;

    for (const paragraph of paragraphs) {
      const sentences = splitIntoSentences(paragraph);

      for (const sentence of sentences) {
        const normalizedSentence = sentence.replace(/\[CHAPTER_BREAK\]/g, "").replace(/\s+/g, " ").trim();
        if (!normalizedSentence) continue;

        const projectedLength = currentText.length + normalizedSentence.length + (currentText ? 1 : 0);

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

function splitIntoSentences(text: string): string[] {
  const protectedText = text
    .replace(/(\d)\.(\d)/g, "$1<DOT>$2")
    .replace(/\b(Dr|Mr|Mrs|Ms|Prof|St|Ave|etc|i\.e|e\.g|vs|Vol|vol|Inc|Ltd|Jr|Sr|Mt|Gen|Gov|Sgt|Cpl|Rev|Hon|Capt|Col|Maj|Lt|Cmdr)\.?/gi,
      (match) => match.replace(".", "<DOT>")
    )
    .replace(/\.{3,}/g, "<ELLIPSIS>")
    .replace(/([A-Z]\.)+/g, (match) => match.replace(/\./g, "<DOT>"));

  const sentenceRegex = /[^.!?]+[.!?]+["']?\s*/g;
  const sentencesRaw = protectedText.match(sentenceRegex) || [];
  const joined = sentencesRaw.map(s => s.trim()).join(" ");
  const remainder = protectedText.slice(joined.length).replace(/<DOT>/g, ".").replace(/<ELLIPSIS>/g, "...").trim();
  const result = sentencesRaw
    .map((s) => s.replace(/<DOT>/g, ".").replace(/<ELLIPSIS>/g, "...").trim())
    .filter((s) => s.length > 0);
  if (remainder.length > 2) result.push(remainder);
  return result.length > 0 ? result : [text];
}

// Voice sample preparation
interface ProcessedSample {
  buffer: Buffer;
  quality: number;
  duration: number;
}

async function prepareVoiceSamples(
  voiceStoragePaths: string[],
  videoId: string | null,
  startTime: number,
  endTime: number,
  jobId: string
): Promise<{ buffer: Buffer }> {
  if (voiceStoragePaths.length === 0) {
    throw new Error("No voice samples provided.");
  }

  const processedSamples: ProcessedSample[] = [];
  
  for (const storagePath of voiceStoragePaths) {
    try {
      console.log(`[Job ${jobId}] Processing voice sample: ${storagePath}`);
      
      const voiceBuffer = await downloadFile(storagePath);
      
      const clipDuration = endTime - startTime;
      if (clipDuration < 3) {
        console.warn(`[Job ${jobId}] Voice clip too short: ${clipDuration}s, skipping`);
        continue;
      }

      // Cap at 15s for F5-TTS (good quality, manageable size)
      const cappedEndTime = Math.min(endTime, startTime + 15);
      const clippedBuffer = await clipAudioBuffer(voiceBuffer, startTime, cappedEndTime);
      
      const duration = cappedEndTime - startTime;
      const quality = estimateSampleQuality(clippedBuffer, duration);
      
      processedSamples.push({ buffer: clippedBuffer, quality, duration });
    } catch (err) {
      console.warn(`[Job ${jobId}] Failed to process sample ${storagePath}:`, err);
    }
  }

  if (processedSamples.length === 0) {
    throw new Error("No valid voice samples could be processed");
  }

  processedSamples.sort((a, b) => b.quality - a.quality);
  console.log(`[Job ${jobId}] Processed ${processedSamples.length} samples. Best quality: ${processedSamples[0]!.quality.toFixed(2)}`);

  const bestSample = processedSamples[0]!;
  let finalBuffer: Buffer;

  if (processedSamples.length === 1) {
    finalBuffer = bestSample.buffer;
  } else {
    const topSamples = processedSamples.slice(0, Math.min(3, processedSamples.length));
    finalBuffer = topSamples.length > 1
      ? await concatenateSamples(topSamples.map(s => s.buffer))
      : bestSample.buffer;
  }

  return { buffer: finalBuffer };
}

function estimateSampleQuality(buffer: Buffer, duration: number): number {
  let score = 1.0;
  if (duration < 5) score *= 0.8;
  if (duration < 3) score *= 0.5;
  if (duration > 30) score *= 0.9;
  const sizeMB = buffer.length / (1024 * 1024);
  if (sizeMB < 0.1) score *= 0.7;
  if (sizeMB > 10) score *= 0.8;
  return score;
}

async function concatenateSamples(buffers: Buffer[]): Promise<Buffer> {
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
    for (let i = 0; i < buffers.length; i++) {
      const filePath = path.join(tempDir, `sample_${i}_${Date.now()}.wav`);
      fs.writeFileSync(filePath, buffers[i]!);
      files.push(filePath);
    }
    
    listFile = path.join(tempDir, `list_${Date.now()}.txt`);
    const listContent = files.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(listFile, listContent);
    
    outputPath = path.join(tempDir, `combined_${Date.now()}.wav`);
    await execAsync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -ac 1 -ar ${F5_TTS_CONFIG.SAMPLE_RATE} "${outputPath}"`);
    
    return fs.readFileSync(outputPath) as Buffer;
  } finally {
    for (const f of files) { try { fs.unlinkSync(f); } catch {} }
    if (listFile) try { fs.unlinkSync(listFile); } catch {}
    if (outputPath) try { fs.unlinkSync(outputPath); } catch {}
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
    
    // Output 24kHz mono WAV for F5-TTS
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" -ss ${startTime} -t ${duration} -ac 1 -ar ${F5_TTS_CONFIG.SAMPLE_RATE} "${outputPath}"`;
    
    await execAsync(ffmpegCmd);
    
    return fs.readFileSync(outputPath) as Buffer;
  } finally {
    try {
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    } catch {}
  }
}

// Checkpoint persistence
async function loadCheckpoints(jobId: string): Promise<ProgressCheckpoint[]> {
  try {
    const checkpointPath = `checkpoints/${jobId}/checkpoints.json`;
    if (!(await fileExists(checkpointPath))) {
      return [];
    }
    const data = await downloadFile(checkpointPath);
    return JSON.parse(data.toString('utf-8'));
  } catch {
    return [];
  }
}

async function saveCheckpoints(jobId: string, checkpoints: ProgressCheckpoint[]): Promise<void> {
  try {
    const checkpointPath = `checkpoints/${jobId}/checkpoints.json`;
    const data = Buffer.from(JSON.stringify(checkpoints), 'utf-8');
    await uploadFile(`checkpoints/${jobId}`, "checkpoints.json", data, "application/json");
  } catch (err) {
    console.warn(`[saveCheckpoints] Failed: ${err}`);
  }
}

// Helpers
async function extractDocumentText(storagePath: string): Promise<string> {
  const fileBuffer = await downloadFile(storagePath);
  const { extractTextFromDocument } = await import("@/lib/text-extraction");
  
  const fileName = storagePath.split("/").pop() || "unknown.txt";
  const text = await extractTextFromDocument(fileBuffer, fileName);
  
  if (!text?.trim()) {
    throw new Error("Could not extract text from document.");
  }
  
  return text;
}

async function concatenateFromBuffers(
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

      let buffer = audioBuffers.get(checkpoint.sectionIndex);
      if (!buffer) {
        buffer = await downloadFile(checkpoint.audioPath);
      }

      const filePath = path.join(tempDir, `section_${String(i).padStart(4, '0')}.wav`);
      fs.writeFileSync(filePath, buffer);
      audioFiles.push(filePath);
    }
    
    if (audioFiles.length === 0) {
      throw new Error("No audio files to concatenate");
    }
    
    if (audioFiles.length === 1) {
      return fs.readFileSync(audioFiles[0]!) as Buffer;
    }
    
    const outputPath = path.join(tempDir, 'output.wav');
    const CROSSFADE_LIMIT = 20;
    
    // Use shorter crossfade for speech (50ms instead of 150ms)
    // This reduces artifacts while maintaining smoothness
    if (audioFiles.length === 2) {
      const ffmpegCmd = `ffmpeg -y -i "${audioFiles[0]}" -i "${audioFiles[1]}" -filter_complex "acrossfade=d=0.05:c1=tri:c2=tri" "${outputPath}"`;
      await execAsync(ffmpegCmd);
    } else if (audioFiles.length <= CROSSFADE_LIMIT) {
      const inputs = audioFiles.map(f => `-i "${f}"`).join(' ');
      let filterParts: string[] = [];
      let prevLabel = "0:a";
      
      for (let i = 1; i < audioFiles.length; i++) {
        const outLabel = i === audioFiles.length - 1 ? "outa" : `a${String(i).padStart(2, '0')}`;
        filterParts.push(`[${prevLabel}][${i}:a]acrossfade=d=0.05:c1=tri:c2=tri[${outLabel}]`);
        prevLabel = outLabel;
      }
      
      const filterStr = filterParts.join('; ');
      const ffmpegCmd = `ffmpeg -y ${inputs} -filter_complex "${filterStr}" -map "[outa]" "${outputPath}"`;
      
      try {
        await execAsync(ffmpegCmd, { maxBuffer: 50 * 1024 * 1024 });
      } catch {
        console.warn(`[Job ${jobId}] Crossfade chain failed, falling back to concat filter`);
        const filterInputs = audioFiles.map((_, i) => `[${i}:a]`).join('');
        const concatFilter = `${filterInputs}concat=n=${audioFiles.length}:v=0:a=1[outa]`;
        const fallbackCmd = `ffmpeg -y ${inputs} -filter_complex "${concatFilter}" -map "[outa]" "${outputPath}"`;
        await execAsync(fallbackCmd, { maxBuffer: 50 * 1024 * 1024 });
      }
    } else {
      console.log(`[Job ${jobId}] ${audioFiles.length} sections, using concat list file`);
      const listFilePath = path.join(tempDir, 'concat_list.txt');
      const listContent = audioFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
      fs.writeFileSync(listFilePath, listContent);
      const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i "${listFilePath}" "${outputPath}"`;
      await execAsync(ffmpegCmd, { maxBuffer: 100 * 1024 * 1024 });
    }
    
    return fs.readFileSync(outputPath) as Buffer;
  } finally {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

async function postProcessAudio(audioBuffer: Buffer, jobId: string): Promise<Buffer> {
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
  
  const inputPath = path.join(tempDir, "input.wav");
  const outputPath = path.join(tempDir, "output.mp3");
  
  try {
    fs.writeFileSync(inputPath, audioBuffer);
    
    // F5-TTS outputs 24kHz WAV - keep quality, just apply gentle normalization
    // No downsampling, no heavy EQ - preserves voice quality
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" ` +
      `-ar ${F5_TTS_CONFIG.SAMPLE_RATE} -ac 1 ` +
      `-af "loudnorm=I=-16:LRA=20:TP=-1:linear=true" ` +
      `-b:a 192k "${outputPath}"`;

    console.log(`[Job ${jobId}] Running post-processing (gentle loudnorm, 24kHz)...`);
    await execAsync(ffmpegCmd, { maxBuffer: 100 * 1024 * 1024 });

    const result = fs.readFileSync(outputPath) as Buffer;
    console.log(`[Job ${jobId}] Post-processing complete: ${audioBuffer.length} → ${result.length} bytes`);
    return result;
  } catch (err) {
    console.warn(`[Job ${jobId}] Post-processing failed, using raw output:`, err);
    return audioBuffer;
  } finally {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  }
}
