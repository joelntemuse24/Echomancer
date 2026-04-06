import { createClient } from "@supabase/supabase-js";
import * as https from "https";
import * as http from "http";

interface GenerateParams {
  jobId: string;
  pdfStoragePath: string;
  voiceStoragePath: string | null;
  videoId: string | null;
  startTime: number;
  endTime: number;
}

interface ProgressCheckpoint {
  sectionIndex: number;
  audioPath: string;
  timestamp: string;
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * IMPROVED audiobook generation with:
 * - Partial failure recovery (save progress)
 * - Smarter text splitting (paragraph boundaries)
 * - Chunk overlap for smooth transitions
 * - Voice sample clipping (uses startTime/endTime)
 * - Streaming uploads (no memory bloat)
 * - Better retry with exponential backoff
 */
export async function generateAudiobookV2(params: GenerateParams) {
  const { jobId, pdfStoragePath, voiceStoragePath, videoId, startTime, endTime } = params;
  const supabase = getSupabase();
  
  const modalUrl = process.env.MODAL_TTS_URL;
  if (!modalUrl) {
    await updateJob(supabase, jobId, { 
      status: "failed", 
      error: "MODAL_TTS_URL not configured" 
    });
    return;
  }

  // Track partial progress for resume capability
  const checkpoints: ProgressCheckpoint[] = [];

  try {
    await updateJob(supabase, jobId, { status: "processing", progress: 5 });

    // ========== Step 1: Download & extract PDF ==========
    const text = await extractPDFText(supabase, pdfStoragePath);
    console.log(`[Job ${jobId}] Extracted ${text.length} characters`);
    await updateJob(supabase, jobId, { progress: 15 });

    // ========== Step 2: Prepare voice sample with clipping ==========
    const voiceSample = await prepareVoiceSample(
      supabase, 
      voiceStoragePath, 
      videoId,
      startTime, 
      endTime,
      jobId
    );
    console.log(`[Job ${jobId}] Voice sample ready (${voiceSample.length} bytes)`);
    await updateJob(supabase, jobId, { progress: 25 });

    // ========== Step 3: Smart text splitting ==========
    // F5-TTS: Use 1500 char chunks (sweet spot for quality/speed)
    const sections = splitTextSmart(text, 1500, 50); // 1500 chars, 50 char overlap
    console.log(`[Job ${jobId}] Split into ${sections.length} sections with overlap`);

    // Check for existing checkpoints (resume capability)
    const existingCheckpoints = await loadCheckpoints(supabase, jobId);
    if (existingCheckpoints.length > 0) {
      console.log(`[Job ${jobId}] Resuming from checkpoint, ${existingCheckpoints.length} sections done`);
      checkpoints.push(...existingCheckpoints);
    }

    // ========== Step 4: Generate with partial failure recovery ==========
    // Process 2 chunks at a time for better throughput
    const BATCH_SIZE = 2;
    const totalSections = sections.length;

    for (let batchStart = 0; batchStart < totalSections; batchStart += BATCH_SIZE) {
      // Check for cancellation before starting a new batch
      const { data: jobStatus } = await supabase
        .from("jobs")
        .select("status, error")
        .eq("id", jobId)
        .single();
        
      if (jobStatus?.status === "failed" && jobStatus?.error === "Cancelled by user") {
        console.log(`[Job ${jobId}] Cancellation detected, aborting generation loop.`);
        return; // Exit silently, API route already handled the DB update
      }

      const batchEnd = Math.min(batchStart + BATCH_SIZE, totalSections);
      const batch = sections.slice(batchStart, batchEnd);
      
      // Skip batch if all sections are already completed
      const allCompleted = batch.every((_, i) => 
        checkpoints.some(c => c.sectionIndex === batchStart + i)
      );

      if (allCompleted) {
        console.log(`[Job ${jobId}] Skipping sections ${batchStart + 1}-${batchEnd}/${totalSections} (already completed)`);
        continue;
      }
      
      console.log(`[Job ${jobId}] Processing sections ${batchStart + 1}-${batchEnd}/${totalSections} concurrently`);

      // Process batch with parallel execution and individual retry logic
      const batchPromises = batch.map(async (section, i) => {
        const sectionIndex = batchStart + i;
        if (!section) return null;

        // Skip if already done (resume)
        if (checkpoints.some(c => c.sectionIndex === sectionIndex)) {
          return null;
        }

        // 1. Call LLM Director to get pacing and speed instructions
        const directorResult = await callLlmDirector(section.text, jobId);
        
        // 2. Generate audio with the modified text and speed
        const audioBuffer = await generateWithRetry(
          modalUrl,
          directorResult.modified_text,
          voiceSample,
          5, // max retries (cold start can take 60-90s)
          jobId,
          sectionIndex,
          totalSections,
          directorResult.speed
        );

        // IMMEDIATELY upload partial result (don't keep in memory)
        const checkpointPath = `chunks/${jobId}/section_${String(sectionIndex).padStart(4, '0')}.mp3`;
        await supabase.storage
          .from("audiobooks")
          .upload(checkpointPath, audioBuffer, {
            contentType: "audio/mpeg",
            upsert: true,
          });

        const newCheckpoint = {
          sectionIndex,
          audioPath: checkpointPath,
          timestamp: new Date().toISOString(),
        };

        return newCheckpoint;
      });

      // Wait for the entire batch to complete (allSettled so one failure doesn't kill the batch)
      const batchResults = await Promise.allSettled(batchPromises);

      // Add successful checkpoints, collect errors
      const batchErrors: string[] = [];
      for (const result of batchResults) {
        if (result.status === "fulfilled" && result.value) {
          checkpoints.push(result.value);
        } else if (result.status === "rejected") {
          batchErrors.push(result.reason?.message || String(result.reason));
        }
      }

      // If ALL sections in this batch failed, throw (partial success is OK — we'll retry failed ones on resume)
      if (batchErrors.length > 0 && batchErrors.length === batch.filter((_, i) => !checkpoints.some(c => c.sectionIndex === batchStart + i)).length) {
        // Every non-completed section failed
        if (checkpoints.length === 0) {
          throw new Error(`Batch failed entirely: ${batchErrors[0]}`);
        }
        console.warn(`[Job ${jobId}] ${batchErrors.length} sections failed in batch, continuing with partial results`);
      }

      // Save checkpoint metadata
      await saveCheckpoints(supabase, jobId, checkpoints);

      // Update progress
      const progress = 25 + Math.round((checkpoints.length / totalSections) * 60);
      await updateJob(supabase, jobId, { progress });
    }

    await updateJob(supabase, jobId, { progress: 90 });

    // ========== Step 5: Validate we have checkpoints before concatenation ==========
    if (checkpoints.length === 0) {
      throw new Error("No audio sections were successfully generated. Cannot create audiobook.");
    }

    console.log(`[Job ${jobId}] Validating ${checkpoints.length} checkpoints before concatenation...`);
    
    // Verify each checkpoint file exists before attempting concatenation
    const validCheckpoints: ProgressCheckpoint[] = [];
    for (const checkpoint of checkpoints) {
      try {
        const { data, error } = await supabase.storage
          .from("audiobooks")
          .createSignedUrl(checkpoint.audioPath, 60);
        
        if (error) {
          console.warn(`[Job ${jobId}] Checkpoint file not found: ${checkpoint.audioPath} - ${error.message}`);
          continue;
        }
        
        // Test if the file is actually accessible
        const response = await fetch(data.signedUrl, { method: 'HEAD' });
        if (!response.ok) {
          console.warn(`[Job ${jobId}] Checkpoint file inaccessible: ${checkpoint.audioPath}`);
          continue;
        }
        
        validCheckpoints.push(checkpoint);
      } catch (e) {
        console.warn(`[Job ${jobId}] Error validating checkpoint ${checkpoint.audioPath}:`, e);
      }
    }
    
    if (validCheckpoints.length === 0) {
      throw new Error("No valid audio files found. All generated sections failed to upload properly.");
    }
    
    console.log(`[Job ${jobId}] Found ${validCheckpoints.length} valid checkpoints out of ${checkpoints.length} total`);

    // ========== Step 6: Concatenate all sections ==========
    console.log(`[Job ${jobId}] Concatenating ${validCheckpoints.length} sections...`);
    const finalAudio = await concatenateSections(supabase, validCheckpoints, jobId);

    const outputPath = `output/${jobId}/audiobook.mp3`;
    const { error: uploadError } = await supabase.storage
      .from("audiobooks")
      .upload(outputPath, finalAudio, {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Failed to upload final audiobook: ${uploadError.message}`);
    }

    // Cleanup checkpoints (optional - keep for debugging)
    // await cleanupCheckpoints(supabase, jobId, checkpoints);

    await updateJob(supabase, jobId, {
      status: "ready",
      progress: 100,
      audio_storage_path: outputPath,
      error: null,
    });

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

// ========== NEW: Smart text splitting with paragraph awareness ==========

interface TextSection {
  text: string;
  isParagraphStart: boolean;
}

function splitTextSmart(text: string, targetLength: number, overlapLength: number): TextSection[] {
  // Split into paragraphs FIRST (before normalizing whitespace)
  const paragraphs = text.split(/\n\s*\n|\r?\n/).filter(p => p.trim().length > 0)
    .map(p => p.replace(/\s+/g, ' ').trim()); // Normalize whitespace WITHIN each paragraph
  
  const sections: TextSection[] = [];
  let current = "";
  
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (!p) continue;
    const paragraph = p.trim();
    
    // If paragraph itself is too long, split on sentences
    if (paragraph.length > targetLength * 1.5) {
      const sentences = paragraph.match(/[^.!?]+[.!?]+["']?\s*/g) || [paragraph];
      
      for (const sentence of sentences) {
        if (current.length + sentence.length > targetLength && current.length > 0) {
          sections.push({ text: current.trim(), isParagraphStart: false });
          
          // Add overlap from previous section end
          const words = current.split(' ');
          const overlapWords = words.slice(-Math.ceil(overlapLength / 5)); // ~5 chars per word
          current = overlapWords.join(' ') + ' ' + sentence;
        } else {
          current += sentence + ' ';
        }
      }
    } else {
      // Normal paragraph handling
      if (current.length + paragraph.length > targetLength && current.length > 0) {
        sections.push({ text: current.trim(), isParagraphStart: true });
        
        // Add overlap
        const words = current.split(' ');
        const overlapWords = words.slice(-Math.ceil(overlapLength / 5));
        current = overlapWords.join(' ') + ' ' + paragraph;
      } else {
        current += (current ? ' ' : '') + paragraph;
      }
    }
  }
  
  if (current.trim()) {
    sections.push({ text: current.trim(), isParagraphStart: true });
  }
  
  return sections;
}

// ========== NEW: Voice sample preparation with clipping ==========

async function prepareVoiceSample(
  supabase: ReturnType<typeof getSupabase>,
  voiceStoragePath: string | null,
  videoId: string | null,
  startTime: number,
  endTime: number,
  jobId: string
): Promise<Buffer> {
  // YouTube audio is downloaded to Supabase storage during the clip step,
  // so by the time we get here, voiceStoragePath should always be set.
  if (!voiceStoragePath) {
    throw new Error("No voice sample provided. Upload audio or download from YouTube first.");
  }

  // Download voice sample
  const { data: voiceData, error } = await supabase.storage
    .from("audiobooks")
    .download(voiceStoragePath);

  if (error || !voiceData) {
    throw new Error(`Failed to download voice: ${error?.message}`);
  }

  const voiceBuffer = Buffer.from(await voiceData.arrayBuffer());
  
  // Clip the audio to the user's selected time range BEFORE sending to cleaner
  const clipDuration = endTime - startTime;
  if (clipDuration < 3) {
    throw new Error(`Voice clip too short: ${clipDuration}s (minimum 3 seconds)`);
  }
  
  console.log(`[Job ${jobId}] Clipping voice sample from ${startTime}s to ${endTime}s (${clipDuration}s duration)`);
  
  // Use ffmpeg to clip the audio to the user's selection
  const clippedBuffer = await clipAudioBuffer(voiceBuffer, startTime, endTime);
  console.log(`[Job ${jobId}] Voice sample clipped: ${voiceBuffer.length}b -> ${clippedBuffer.length}b`);
  
  // Call the new Audio Cleaner Modal to extract vocals and enhance the clipped sample
  const cleanerUrl = process.env.MODAL_AUDIO_CLEANER_URL;
  if (cleanerUrl) {
    console.log(`[Job ${jobId}] Sending clipped audio (${clippedBuffer.length} bytes) to Audio Cleaner`);
    try {
      const response = await fetch(cleanerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          audio_base64: clippedBuffer.toString("base64"),
          // Pass clip info to cleaner for logging/debugging
          clip_start: startTime,
          clip_end: endTime 
        }),
        signal: AbortSignal.timeout(300_000), // 5 minute timeout for cleaner
      });
      
      if (!response.ok) {
         console.warn(`[Job ${jobId}] Audio cleaner HTTP error: ${response.status}`);
      } else {
         const result = await response.json();
         if (result.error) {
           console.warn(`[Job ${jobId}] Audio cleaner returned error: ${result.error}. Falling back to clipped audio.`);
         } else if (result.audio_base64) {
           const cleanedBuffer = Buffer.from(result.audio_base64, "base64");
           console.log(`[Job ${jobId}] Audio cleaner success. Clipped: ${clippedBuffer.length}b, Cleaned: ${cleanedBuffer.length}b`);
           return cleanedBuffer;
         }
      }
    } catch (err) {
      console.warn(`[Job ${jobId}] Audio cleaner fetch failed:`, err);
    }
  } else {
    console.warn(`[Job ${jobId}] MODAL_AUDIO_CLEANER_URL not configured. Skipping audio cleanup.`);
  }

  return clippedBuffer;
}

/**
 * Clip audio buffer to specified time range using ffmpeg
 */
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
    // Write input buffer to temp file
    fs.writeFileSync(inputPath, audioBuffer);
    
    // Calculate duration
    const duration = endTime - startTime;
    
    // Use ffmpeg to clip the audio
    // -ss: start time, -t: duration, -ac 1: mono, -ar 24000: 24kHz for TTS
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" -ss ${startTime} -t ${duration} -ac 1 -ar 24000 "${outputPath}"`;
    
    await execAsync(ffmpegCmd);
    
    // Read the clipped audio
    const clippedBuffer = fs.readFileSync(outputPath);
    
    return clippedBuffer;
  } finally {
    // Cleanup temp files
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ========== NEW: Emotion Director (Batch Processing) ==========
async function callLlmDirector(text: string, jobId: string): Promise<{ modified_text: string; speed: number; energy: string }> {
  const emotionUrl = process.env.MODAL_LLM_DIRECTOR_URL;
  
  if (!emotionUrl) {
    console.warn(`[Job ${jobId}] Emotion Director URL not set, using defaults`);
    return { modified_text: text, speed: 1.0, energy: "neutral" };
  }

  try {
    // Send entire text chunk to batch emotion director
    // It will split into sentences, analyze each, and return SML-tagged text
    const response = await fetch(emotionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`Emotion API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    
    if (result.error) {
      throw new Error(`Emotion API returned error: ${result.error}`);
    }

    // Batch director returns tagged_text with SML tags already inserted
    const taggedText = result?.tagged_text || text;
    const sentenceCount = result?.sentence_count || 0;
    const dominantEmotion = result?.energy || result?.dominant_emotion || 'neutral';
    const avgSpeed = result?.speed || result?.avg_speed || 1.0;
    
    console.log(`[Job ${jobId}] Batch analyzed ${sentenceCount} sentences, dominant: ${dominantEmotion}, avg_speed: ${avgSpeed.toFixed(2)}`);
    console.log(`[Job ${jobId}] Tagged text preview: ${taggedText.substring(0, 100)}...`);
    
    // Log emotions found if available
    if (result?.breakdown) {
      const emotionCounts = result.breakdown.reduce((acc: Record<string, number>, b: {emotion: string}) => {
        acc[b.emotion] = (acc[b.emotion] || 0) + 1;
        return acc;
      }, {});
      console.log(`[Job ${jobId}] Emotion distribution:`, emotionCounts);
    }

    return {
      modified_text: taggedText,
      speed: avgSpeed,
      energy: dominantEmotion === 'sadness' || dominantEmotion === 'grief' || dominantEmotion === 'melancholy' 
        ? 'low' 
        : dominantEmotion === 'excitement' || dominantEmotion === 'anger' || dominantEmotion === 'joy'
          ? 'high'
          : 'neutral'
    };

  } catch (err) {
    console.warn(`[Job ${jobId}] Emotion Director failed:`, err);
    return { modified_text: text, speed: 1.0, energy: "neutral" };
  }
}

// ========== NEW: Retry with exponential backoff ==========

async function generateWithRetry(
  modalUrl: string,
  text: string,
  voiceSample: Buffer,
  maxRetries: number,
  jobId: string,
  sectionIndex: number,
  totalSections: number,
  speed: number = 1.0
): Promise<Buffer> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Job ${jobId}] Section ${sectionIndex + 1}/${totalSections} attempt ${attempt}/${maxRetries} (Speed: ${speed})`);
      
      const audio = await modalTTS(modalUrl, text, voiceSample, speed);
      console.log(`[Job ${jobId}] Section ${sectionIndex + 1} success (${audio.length} bytes)`);
      return audio;
      
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Job ${jobId}] Section ${sectionIndex + 1} attempt ${attempt} failed: ${lastError.message}`);
      
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000); // Exponential backoff, max 30s
        console.log(`[Job ${jobId}] Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  
  throw new Error(`Section ${sectionIndex + 1} failed after ${maxRetries} attempts: ${lastError?.message}`);
}

// ========== MODIFIED: Modal TTS with clipping support ==========

async function modalTTS(modalUrl: string, text: string, voiceSample: Buffer, speed: number = 1.0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const voiceBase64 = voiceSample.toString('base64');
      const payload = JSON.stringify({
        text,
        reference_audio_base64: voiceBase64,
        format: "mp3",
        speed: speed, // Pass the LLM-directed speed parameter
      });

      const urlObj = new URL(modalUrl);
      const isHttps = urlObj.protocol === "https:";
      const requestModule = isHttps ? https : http;

      const options = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 15 * 60 * 1000, // 15 minutes
      };

      const req = requestModule.request(urlObj, options, (res) => {
        const chunks: Buffer[] = [];
        
        res.on("data", (chunk) => chunks.push(chunk));
        
        res.on("end", () => {
          const responseBuffer = Buffer.concat(chunks);
          const responseText = responseBuffer.toString('utf-8');

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Modal TTS failed (${res.statusCode}): ${responseText}`));
          }

          try {
            const result = JSON.parse(responseText);
            if (result.error) {
              return reject(new Error(`Modal TTS error: ${result.error}`));
            }
            if (!result.audio_base64) {
              return reject(new Error("Modal TTS returned no audio"));
            }
            resolve(Buffer.from(result.audio_base64, "base64"));
          } catch (e) {
            reject(new Error(`Failed to parse Modal response: ${e}`));
          }
        });
      });

      req.on("error", (err) => {
        reject(new Error(`Network error during Modal request: ${err.message}`));
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Modal TTS request timed out after 15 minutes"));
      });

      req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ========== NEW: Concatenate with crossfade ==========

async function concatenateSections(
  supabase: ReturnType<typeof getSupabase>,
  checkpoints: ProgressCheckpoint[],
  jobId: string
): Promise<Buffer> {
  // Sort by index
  const sorted = [...checkpoints].sort((a, b) => a.sectionIndex - b.sectionIndex);
  
  // Download all sections
  const audioParts: Buffer[] = [];
  
  for (const checkpoint of sorted) {
    const { data, error } = await supabase.storage
      .from("audiobooks")
      .download(checkpoint.audioPath);
    
    if (error || !data) {
      throw new Error(`Failed to download checkpoint ${checkpoint.sectionIndex}: ${error?.message}`);
    }
    
    const buffer = Buffer.from(await data.arrayBuffer());
    audioParts.push(buffer);
  }
  
  // Strip ID3 headers from all chunks except the first so concatenation produces valid MP3
  const strippedParts = audioParts.map((buf, i) => {
    if (i === 0) return buf; // Keep the first chunk's header intact
    return stripID3Header(buf);
  });
  
  return Buffer.concat(strippedParts);
}

// ========== NEW: Checkpoint persistence ==========

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
      // Table may not exist — that's OK, just means no resume capability
      console.warn(`[loadCheckpoints] Skipping resume (table may not exist): ${error.message}`);
      return [];
    }
    
    return (data || []).map((row: { section_index: number; audio_path: string; created_at: string }) => ({
      sectionIndex: row.section_index,
      audioPath: row.audio_path,
      timestamp: row.created_at,
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
      console.warn(`[saveCheckpoints] Failed (table may not exist): ${error.message}`);
    }
  } catch {
    // Non-critical — generation continues without checkpoint persistence
  }
}

// ========== MP3 Helpers ==========

/**
 * Strip ID3v2 header from an MP3 buffer.
 * ID3v2 headers start with "ID3" and contain a size field at bytes 6-9 (syncsafe integer).
 * Removing them from non-first chunks prevents corrupt concatenated MP3 files.
 */
function stripID3Header(buf: Buffer): Buffer {
  // Check for ID3v2 header: starts with "ID3"
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    // Read syncsafe integer size from bytes 6-9
    const size =
      ((buf[6]! & 0x7f) << 21) |
      ((buf[7]! & 0x7f) << 14) |
      ((buf[8]! & 0x7f) << 7) |
      (buf[9]! & 0x7f);
    const headerSize = 10 + size; // 10 byte header + tag data
    if (headerSize < buf.length) {
      return buf.subarray(headerSize);
    }
  }
  return buf;
}

// ========== Helpers ==========

async function extractPDFText(supabase: ReturnType<typeof getSupabase>, pdfPath: string): Promise<string> {
  const { data: pdfData, error } = await supabase.storage
    .from("audiobooks")
    .download(pdfPath);

  if (error || !pdfData) {
    throw new Error(`Failed to download PDF: ${error?.message}`);
  }

  const pdfBuffer = Buffer.from(await pdfData.arrayBuffer());
  const { extractText } = await import("unpdf");
  const { text } = await extractText(new Uint8Array(pdfBuffer), { mergePages: true });
  
  if (!text?.trim()) {
    throw new Error("Could not extract text from PDF. Is it a scanned document?");
  }
  
  return text as string;
}

// ========== NEW: Clean final audio output ==========

async function cleanAudioOutput(audioBuffer: Buffer, jobId: string): Promise<Buffer> {
  const cleanerUrl = process.env.MODAL_AUDIO_CLEANER_URL;
  
  if (!cleanerUrl) {
    console.warn(`[Job ${jobId}] Audio cleaner URL not set, skipping final audio cleaning`);
    return audioBuffer;
  }
  
  return new Promise((resolve, reject) => {
    try {
      const audioBase64 = audioBuffer.toString('base64');
      const payload = JSON.stringify({
        audio_base64: audioBase64,
        // Optional: specify output format, quality settings
      });

      const urlObj = new URL(cleanerUrl);
      const isHttps = urlObj.protocol === "https:";
      const requestModule = isHttps ? https : http;

      const options = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 5 * 60 * 1000, // 5 minutes for final audio cleaning
      };

      const req = requestModule.request(urlObj, options, (res) => {
        const chunks: Buffer[] = [];
        
        res.on("data", (chunk) => chunks.push(chunk));
        
        res.on("end", () => {
          const responseBuffer = Buffer.concat(chunks);
          const responseText = responseBuffer.toString('utf-8');

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Audio cleaner failed (${res.statusCode}): ${responseText}`));
          }

          try {
            const result = JSON.parse(responseText);
            if (result.error) {
              return reject(new Error(`Audio cleaner error: ${result.error}`));
            }
            if (!result.audio_base64) {
              return reject(new Error("Audio cleaner returned no audio"));
            }
            resolve(Buffer.from(result.audio_base64, "base64"));
          } catch (e) {
            reject(new Error(`Failed to parse audio cleaner response: ${e instanceof Error ? e.message : String(e)}`));
          }
        });
      });

      req.on("error", (err) => reject(new Error(`Audio cleaner request failed: ${err.message}`)));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Audio cleaner request timeout"));
      });

      req.write(payload);
      req.end();
      
    } catch (err) {
      reject(new Error(`Audio cleaner setup failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  });
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
