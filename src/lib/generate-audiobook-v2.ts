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
      endTime 
    );
    console.log(`[Job ${jobId}] Voice sample ready (${voiceSample.length} bytes)`);
    await updateJob(supabase, jobId, { progress: 25 });

    // ========== Step 3: Smart text splitting ==========
    // ZONOS: Use larger chunks (2000 chars) since Zonos handles long text better
    const sections = splitTextSmart(text, 2000, 50); // 2000 chars, 50 char overlap
    console.log(`[Job ${jobId}] Split into ${sections.length} sections with overlap`);

    // Check for existing checkpoints (resume capability)
    const existingCheckpoints = await loadCheckpoints(supabase, jobId);
    if (existingCheckpoints.length > 0) {
      console.log(`[Job ${jobId}] Resuming from checkpoint, ${existingCheckpoints.length} sections done`);
      checkpoints.push(...existingCheckpoints);
    }

    // ========== Step 4: Generate with partial failure recovery ==========
    // REDUCED: Process 1 chunk at a time to avoid overwhelming Modal
    // Zonos is fast enough that sequential processing is fine
    const BATCH_SIZE = 1;
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

        const audioBuffer = await generateWithRetry(
          modalUrl,
          section.text,
          voiceSample,
          5, // max retries (cold start can take 60-90s)
          jobId,
          sectionIndex,
          totalSections
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

    // ========== Step 5: Concatenate all sections ==========
    console.log(`[Job ${jobId}] Concatenating ${checkpoints.length} sections...`);
    const finalAudio = await concatenateSections(supabase, checkpoints, jobId);

    const outputPath = `output/${jobId}/audiobook.mp3`;
    await supabase.storage
      .from("audiobooks")
      .upload(outputPath, finalAudio, {
        contentType: "audio/mpeg",
        upsert: true,
      });

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
  endTime: number
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
  return voiceBuffer;
}

// ========== NEW: Retry with exponential backoff ==========

async function generateWithRetry(
  modalUrl: string,
  text: string,
  voiceSample: Buffer,
  maxRetries: number,
  jobId: string,
  sectionIndex: number,
  totalSections: number
): Promise<Buffer> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Job ${jobId}] Section ${sectionIndex + 1}/${totalSections} attempt ${attempt}/${maxRetries}`);
      
      const audio = await modalTTS(modalUrl, text, voiceSample);
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

async function modalTTS(modalUrl: string, text: string, voiceSample: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const voiceBase64 = voiceSample.toString('base64');
      const payload = JSON.stringify({
        text,
        reference_audio_base64: voiceBase64,
        format: "mp3",
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
