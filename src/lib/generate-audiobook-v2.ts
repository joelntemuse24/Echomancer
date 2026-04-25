import { getEnv } from "@/lib/env";
import { updateJob } from "@/lib/db/jobs";
import { downloadFile, uploadFile, fileExists } from "@/lib/storage";

// Global AbortController registry — cancel endpoint aborts the controller to stop in-flight Modal requests
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

export async function generateAudiobookV2(params: GenerateParams) {
  const { jobId, pdfStoragePath, voiceStoragePath, voiceStoragePaths, videoId, startTime, endTime } = params;
  
  const env = getEnv();
  const modalUrl = env.MODAL_TTS_URL;
  if (!modalUrl) {
    await updateJob(jobId, { 
      status: "failed", 
      error_message: "MODAL_TTS_URL not configured" 
    });
    return;
  }

  // Register AbortController so cancel endpoint can abort in-flight requests
  const abortController = new AbortController();
  activeJobs.set(jobId, abortController);
  const signal = abortController.signal;

  const checkpoints: ProgressCheckpoint[] = [];
  const jobStartTime = Date.now();

  try {
    await updateJob(jobId, { status: "processing", progress: 5 });

    // Note: First TTS call will be slow (~3-4 min) if Modal container is cold.
    // We don't pre-warm here because the health endpoint runs on a separate container
    // and hitting the generate endpoint would waste a GPU inference just for warmup.
    // The voxCPMBatch timeout (10 min) accommodates cold starts.

    // Step 1: Download & extract PDF
    const rawText = await extractDocumentText(pdfStoragePath);
    console.log(`[Job ${jobId}] Extracted ${rawText.length} characters (raw)`);
    
    const text = preprocessPDFText(rawText, jobId);
    console.log(`[Job ${jobId}] Preprocessed to ${text.length} characters`);
    await updateJob(jobId, { progress: 10 });

    // Step 2: Prepare voice sample(s)
    const voicePaths = voiceStoragePaths && voiceStoragePaths.length > 0 
      ? voiceStoragePaths 
      : voiceStoragePath 
        ? [voiceStoragePath] 
        : [];
    
    if (voicePaths.length === 0) {
      throw new Error("No voice samples provided");
    }
    
    const voiceSample = await prepareVoiceSamples(
      voicePaths, 
      videoId,
      startTime, 
      endTime,
      jobId
    );
    console.log(`[Job ${jobId}] Voice sample ready (${voiceSample.length} bytes) using ${voicePaths.length} reference(s)`);
    await updateJob(jobId, { progress: 20 });

    // Step 3: Text splitting
    const sections = splitBySentences(text, 300);
    console.log(`[Job ${jobId}] Split into ${sections.length} sentence-based sections`);
    
    const totalChars = sections.reduce((s, sec) => s + sec.text.length, 0);
    const estimatedBatchSize = sections.length <= 10 ? 10 : 8;
    const estimatedBatchCount = Math.ceil(sections.length / estimatedBatchSize);
    const estimatedSeconds = Math.round(5 + sections.length * 1.5 + estimatedBatchCount * 5 + 5);
    console.log(`[Job ${jobId}] ⏱ Estimate: ${totalChars} chars, ${sections.length} sections → ~${estimatedSeconds}s (${Math.round(estimatedSeconds / 60)}m${estimatedSeconds % 60}s)`);
    await updateJob(jobId, { progress: 25, total_sections: sections.length });

    // Check for existing checkpoints
    const existingCheckpoints = await loadCheckpoints(jobId);
    if (existingCheckpoints.length > 0) {
      console.log(`[Job ${jobId}] Resuming from checkpoint, ${existingCheckpoints.length} sections done`);
      checkpoints.push(...existingCheckpoints);
    }

    // Step 4: Generate audio via VoxCPM
    const totalSections = sections.length;
    const voiceBase64 = voiceSample.toString("base64");
    const audioBuffers: Map<number, Buffer> = new Map();

    console.log(`[Job ${jobId}] Using VoxCPM for TTS generation`);

    // Keep batches small — each section takes ~25s on VoxCPM,
    // so 8 sections ≈ 200s per batch (well within timeout)
    const BATCH_SIZE = totalSections <= 10 ? 10 : 8;
    
    for (let batchStart = 0; batchStart < totalSections;) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, totalSections);
      const batch = sections.slice(batchStart, batchEnd);
      const batchStartIndex = batchStart;
      batchStart = batchEnd;
      
      const pendingIndices: number[] = [];
      const pendingTexts: string[] = [];
      for (let i = 0; i < batch.length; i++) {
        const sectionIndex = batchStartIndex + i;
        const section = batch[i];
        if (!section) continue;
        if (checkpoints.some(c => c.sectionIndex === sectionIndex)) continue;
        pendingIndices.push(sectionIndex);
        pendingTexts.push(section.text);
      }

      if (pendingTexts.length === 0) {
        console.log(`[Job ${jobId}] Skipping sections ${batchStartIndex + 1}-${batchEnd}/${totalSections} (already completed)`);
        continue;
      }

      // Check if job was cancelled between batches
      if (signal.aborted) {
        console.log(`[Job ${jobId}] Cancelled between batches`);
        await updateJob(jobId, { status: "failed", error_message: "Cancelled by user" });
        activeJobs.delete(jobId);
        return;
      }

      console.log(`[Job ${jobId}] Batch generating sections ${batchStartIndex + 1}-${batchEnd}/${totalSections} (${pendingTexts.length} pending)`);
      const batchStartTime = Date.now();

      let batchResults: Array<{ audio_base64: string; duration_seconds: number }> = [];
      let batchAttempt = 0;
      const maxBatchRetries = 3;

      while (batchAttempt < maxBatchRetries) {
        batchAttempt++;
        try {
          batchResults = await voxCPMBatch(modalUrl, pendingTexts, voiceBase64, jobId, signal);
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[Job ${jobId}] Batch attempt ${batchAttempt} failed: ${errMsg}`);
          if (batchAttempt < maxBatchRetries) {
            const delay = Math.min(1000 * Math.pow(2, batchAttempt), 30000);
            console.log(`[Job ${jobId}] Retrying batch in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
          } else {
            if (checkpoints.length === 0) {
              throw new Error(`Batch failed after ${maxBatchRetries} attempts: ${errMsg}`);
            }
            console.warn(`[Job ${jobId}] Batch failed, continuing with partial results`);
          }
        }
      }

      const failedInBatch: number[] = [];
      for (let r = 0; r < batchResults.length; r++) {
        const result = batchResults[r];
        const sectionIndex = pendingIndices[r];
        if (!result || sectionIndex === undefined) {
          failedInBatch.push(sectionIndex ?? -1);
          continue;
        }
        if ((result as any).error) {
          console.warn(`[Job ${jobId}] Section ${sectionIndex + 1} had error: ${(result as any).error}`);
          if ((result as any).traceback) {
            console.warn(`[Job ${jobId}] Section ${sectionIndex + 1} traceback: ${(result as any).traceback}`);
          }
          failedInBatch.push(sectionIndex);
          continue;
        }
        if (!result.audio_base64) {
          const keys = Object.keys(result).join(',');
          console.warn(`[Job ${jobId}] Section ${sectionIndex + 1} returned no audio. Keys: [${keys}]`);
          if (failedInBatch.length === 0) {
            console.warn(`[Job ${jobId}] First failed result sample: ${JSON.stringify(result).slice(0, 500)}`);
          }
          failedInBatch.push(sectionIndex);
          continue;
        }

        const audioBuffer = Buffer.from(result.audio_base64, "base64");
        audioBuffers.set(sectionIndex, audioBuffer);

        checkpoints.push({
          sectionIndex,
          audioPath: `checkpoints/${jobId}/section_${String(sectionIndex).padStart(4, '0')}.mp3`,
          timestamp: new Date().toISOString(),
          textLength: pendingTexts[r]?.length ?? 0,
        });
      }

      if (failedInBatch.length > 0) {
        throw new Error(`${failedInBatch.length} section(s) failed in batch: [${failedInBatch.join(', ')}]`);
      }

      const batchElapsed = ((Date.now() - batchStartTime) / 1000).toFixed(1);
      const batchChars = pendingTexts.reduce((s, t) => s + t.length, 0);
      const charsPerSec = (batchChars / (Date.now() - batchStartTime) * 1000).toFixed(0);
      console.log(`[Job ${jobId}] ⏱ Batch done in ${batchElapsed}s (${batchChars} chars, ${charsPerSec} chars/s)`);
      
      // Save checkpoints
      for (const cp of checkpoints) {
        const buf = audioBuffers.get(cp.sectionIndex);
        if (!buf) continue;
        await uploadFile(`checkpoints/${jobId}`, `section_${String(cp.sectionIndex).padStart(4, '0')}.mp3`, buf, "audio/mpeg");
      }
      
      await saveCheckpoints(jobId, checkpoints);
      console.log(`[Job ${jobId}] Checkpoint batch saved (${checkpoints.length} sections uploaded)`);

      const progress = 25 + Math.round((checkpoints.length / totalSections) * 55);
      await updateJob(jobId, { progress, current_section: checkpoints.length });
    }

    await updateJob(jobId, { progress: 85 });

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

    // Step 6: Concatenate
    console.log(`[Job ${jobId}] Concatenating ${validCheckpoints.length} sections...`);
    let concatenatedAudio: Buffer = await concatenateFromBuffers(validCheckpoints, audioBuffers, jobId);

    // Step 7: Post-processing
    console.log(`[Job ${jobId}] Post-processing: gentle loudnorm at 48kHz...`);
    concatenatedAudio = await postProcessAudio(concatenatedAudio, jobId);

    await updateJob(jobId, { progress: 95 });

    const outputPath = `audiobooks/${jobId}/audiobook.mp3`;
    await uploadFile(`audiobooks/${jobId}`, "audiobook.mp3", concatenatedAudio, "audio/mpeg");

    await updateJob(jobId, {
      status: "ready",
      progress: 100,
      audio_storage_path: outputPath,
      error_message: null,
    });

    const totalElapsed = ((Date.now() - jobStartTime) / 1000).toFixed(1);
    console.log(`[Job ${jobId}] ⏱ Complete in ${totalElapsed}s — estimated ~${estimatedSeconds}s`);
    console.log(`[Job ${jobId}] Complete!`);
    activeJobs.delete(jobId);

  } catch (error) {
    // If aborted by cancel, don't overwrite the cancel status
    if (error instanceof DOMException && error.name === "AbortError") {
      console.log(`[Job ${jobId}] Generation aborted by cancel`);
      await updateJob(jobId, { status: "failed", error_message: "Cancelled by user" });
      activeJobs.delete(jobId);
      return;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Job ${jobId}] Failed: ${errorMessage}`);

    if (checkpoints.length > 0) {
      await updateJob(jobId, {
        status: "failed",
        progress: Math.round((checkpoints.length / (checkpoints.length + 5)) * 100),
        error_message: `Partial failure: ${checkpoints.length} sections completed. Error: ${errorMessage}`,
      });
    } else {
      await updateJob(jobId, {
        status: "failed",
        error_message: errorMessage,
      });
    }
    activeJobs.delete(jobId);
  }
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
    (match) => `${CHAPTER_BREAK}${match.trim()}.\n\n`
  );

  text = text.replace(
    /\n\s*([A-Z][A-Z\s]{2,58}[A-Z])\s*\n/g,
    (match, title: string) => {
      const wordCount = title.trim().split(/\s+/).length;
      if (wordCount >= 1 && wordCount <= 8) {
        return `${CHAPTER_BREAK}${title.trim()}.\n\n`;
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

function splitBySentences(text: string, targetLength: number = 600): TextSection[] {
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
        const normalizedSentence = sentence.replace(/\s+/g, " ").trim();
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
  const sentencesRaw = protectedText.match(sentenceRegex) || [protectedText];

  return sentencesRaw
    .map((s) => s.replace(/<DOT>/g, ".").replace(/<ELLIPSIS>/g, "...").trim())
    .filter((s) => s.length > 0);
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
): Promise<Buffer> {
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
      
      let clippedBuffer = await clipAudioBuffer(voiceBuffer, startTime, endTime);
      
      const isUploaded = !videoId;
      const cleanerUrl = getEnv().MODAL_AUDIO_CLEANER_URL;
      if (cleanerUrl && !isUploaded) {
        try {
          const response = await fetch(cleanerUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audio_base64: clippedBuffer.toString("base64") }),
            signal: AbortSignal.timeout(300_000),
          });
          
          if (response.ok) {
            const result = await response.json();
            if (result.audio_base64) {
              clippedBuffer = Buffer.from(result.audio_base64, "base64");
            }
          }
        } catch (err) {
          console.warn(`[Job ${jobId}] Audio cleaner failed, using raw clip:`, err);
        }
      }
      
      clippedBuffer = await enhanceVoiceSample(clippedBuffer, jobId);
      
      const duration = endTime - startTime;
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
  
  if (processedSamples.length === 1) {
    return processedSamples[0]!.buffer;
  }
  
  const topSamples = processedSamples.slice(0, Math.min(3, processedSamples.length));
  if (topSamples.length > 1) {
    console.log(`[Job ${jobId}] Combining top ${topSamples.length} samples for diversity`);
    return concatenateSamples(topSamples.map(s => s.buffer));
  }
  
  return processedSamples[0]!.buffer;
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
    await execAsync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -ac 1 -ar 24000 "${outputPath}"`);
    
    return fs.readFileSync(outputPath) as Buffer;
  } finally {
    for (const f of files) { try { fs.unlinkSync(f); } catch {} }
    if (listFile) try { fs.unlinkSync(listFile); } catch {}
    if (outputPath) try { fs.unlinkSync(outputPath); } catch {}
  }
}

async function normalizeAudio(buffer: Buffer): Promise<Buffer> {
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

async function enhanceVoiceSample(buffer: Buffer, jobId: string): Promise<Buffer> {
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
    console.warn(`[Job ${jobId}] Voice enhancement failed, falling back to normalize:`, err);
    return normalizeAudio(buffer);
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
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
  
  const inputPath = path.join(tempDir, "input.mp3");
  const outputPath = path.join(tempDir, "output.mp3");
  
  try {
    fs.writeFileSync(inputPath, audioBuffer);
    
    // VoxCPM2 outputs 48kHz mono audio — preserve sample rate and channel count.
    // Only apply gentle loudnorm for consistency between sections.
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" ` +
      `-ar 48000 -ac 1 ` +
      `-af "loudnorm=I=-16:LRA=20:TP=-1" ` +
      `-b:a 192k "${outputPath}"`;

    console.log(`[Job ${jobId}] Running post-processing pipeline (48kHz, gentle loudnorm)...`);
    await execAsync(ffmpegCmd, { maxBuffer: 100 * 1024 * 1024 });

    const result = fs.readFileSync(outputPath) as Buffer;
    console.log(`[Job ${jobId}] Post-processing complete: ${audioBuffer.length} → ${result.length} bytes`);
    return result;
  } catch (err) {
    console.warn(`[Job ${jobId}] Full post-processing failed, trying simple normalize:`, err);
    try {
      const fallbackCmd = `ffmpeg -y -i "${inputPath}" -ar 48000 -ac 1 -b:a 192k "${outputPath}"`;
      await execAsync(fallbackCmd, { maxBuffer: 100 * 1024 * 1024 });
      return fs.readFileSync(outputPath) as Buffer;
    } catch {
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
    
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" -ss ${startTime} -t ${duration} -ac 1 -ar 24000 "${outputPath}"`;
    
    await execAsync(ffmpegCmd);
    
    return fs.readFileSync(outputPath) as Buffer;
  } finally {
    try {
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    } catch {}
  }
}

// VoxCPM TTS functions
async function voxCPMBatch(
  baseUrl: string,
  texts: string[],
  voiceBase64: string,
  jobId: string,
  externalSignal?: AbortSignal,
): Promise<Array<{ audio_base64: string; duration_seconds: number; error?: string }>> {
  // Use dedicated batch URL env var, or derive from single URL
  // Modal URL pattern: https://<user>--<app>-<class>-<method>.modal.run
  // Replace -generate. with -generate-batch. in the subdomain
  const batchUrl = getEnv().MODAL_TTS_BATCH_URL
    || baseUrl.replace(/-generate\./, "-generate-batch.");
  if (batchUrl === baseUrl) {
    throw new Error("Failed to derive batch URL from MODAL_TTS_URL. Please set MODAL_TTS_BATCH_URL explicitly.");
  }

  console.log(`[Job ${jobId}] Sending batch of ${texts.length} texts to VoxCPM`);

  const payload = {
    texts,
    reference_audio_base64: voiceBase64,
    reference_text: null,
    cfg_value: 2.0,
    inference_timesteps: 10,
  };

  // Using fetch() instead of https.request because Modal returns 303 redirects
  // during cold starts, and fetch() follows redirects automatically.
  // Combine abort signal (cancel) with timeout signal (cold start protection)
  const timeoutSignal = AbortSignal.timeout(20 * 60 * 1000);
  const combinedSignal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(batchUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: combinedSignal,
  });

  const responseText = await response.text();

  if (!response.ok) {
    let errorMsg = `VoxCPM batch failed (${response.status})`;
    if (response.status === 422) {
      errorMsg = `VoxCPM validation error (422): missing or invalid fields. Response: ${responseText.slice(0, 300)}`;
    } else if (response.status === 504) {
      errorMsg = `VoxCPM timed out (504): model may be cold-starting. Try again in a few minutes.`;
    } else {
      errorMsg += `: ${responseText.slice(0, 500)}`;
    }
    throw new Error(errorMsg);
  }

  const result = JSON.parse(responseText);
  if (result.error) {
    throw new Error(`VoxCPM error: ${result.error}`);
  }
  if (!result.results || !Array.isArray(result.results)) {
    throw new Error("VoxCPM returned no results array");
  }
  if (result.errors && result.errors.length > 0) {
    console.warn(`[Job ${jobId}] VoxCPM reported errors at indices: ${result.errors.join(', ')}`);
  }
  return result.results;
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
    const CROSSFADE_LIMIT = 20;
    
    if (audioFiles.length === 2) {
      const ffmpegCmd = `ffmpeg -y -i "${audioFiles[0]}" -i "${audioFiles[1]}" -filter_complex "acrossfade=d=0.05:c1=tri:c2=tri" -b:a 192k "${outputPath}"`;
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
      const ffmpegCmd = `ffmpeg -y ${inputs} -filter_complex "${filterStr}" -map "[outa]" -b:a 192k "${outputPath}"`;
      
      try {
        await execAsync(ffmpegCmd, { maxBuffer: 50 * 1024 * 1024 });
      } catch {
        console.warn(`[Job ${jobId}] Crossfade chain failed, falling back to concat filter`);
        const filterInputs = audioFiles.map((_, i) => `[${i}:a]`).join('');
        const concatFilter = `${filterInputs}concat=n=${audioFiles.length}:v=0:a=1[outa]`;
        const fallbackCmd = `ffmpeg -y ${inputs} -filter_complex "${concatFilter}" -map "[outa]" -b:a 192k "${outputPath}"`;
        await execAsync(fallbackCmd, { maxBuffer: 50 * 1024 * 1024 });
      }
    } else {
      console.log(`[Job ${jobId}] ${audioFiles.length} sections, using concat filter`);
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
    } catch {}
  }
}
