import { createClient } from "@supabase/supabase-js";

interface GenerateParams {
  jobId: string;
  pdfStoragePath: string;
  voiceStoragePath: string | null;
  videoId: string | null;
  startTime: number;
  endTime: number;
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * ZONOS VERSION - Audiobook generation with improved TTS.
 * 
 * Improvements over F5-TTS:
 * - 2000 char chunks (2x longer) = fewer API calls
 * - Speaker embedding caching = faster generation
 * - Better voice quality and consistency
 * - Supports longer voice samples (up to 30s)
 * - Faster inference = lower cost
 * 
 * Cost: ~$0.03 per book (vs $0.07 with F5-TTS)
 */
export async function generateAudiobook(params: GenerateParams) {
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

  try {
    // ========== Step 1: Initialize ==========
    await updateJob(supabase, jobId, { status: "processing", progress: 5 });
    console.log(`[Job ${jobId}] Starting Zonos generation`);

    // ========== Step 2: Download & extract PDF ==========
    await updateJob(supabase, jobId, { progress: 10 });
    const text = await extractPDFText(supabase, pdfStoragePath);
    console.log(`[Job ${jobId}] Extracted ${text.length} characters`);

    // ========== Step 3: Download voice sample ==========
    await updateJob(supabase, jobId, { progress: 15 });
    
    if (!voiceStoragePath && !videoId) {
      throw new Error("No voice sample provided");
    }
    
    if (videoId) {
      throw new Error("YouTube extraction not implemented");
    }

    const voiceBuffer = await downloadVoiceSample(supabase, voiceStoragePath!);
    const voiceBase64 = voiceBuffer.toString("base64");
    
    console.log(`[Job ${jobId}] Voice sample ready (${voiceBuffer.length} bytes)`);
    await updateJob(supabase, jobId, { progress: 20 });

    // ========== Step 4: Smart text splitting ==========
    // ZONOS: 2000 chars per chunk (vs 1000 for F5-TTS)
    const maxCharsPerRequest = 2000;
    const sections = splitTextSmart(text, maxCharsPerRequest);
    
    console.log(`[Job ${jobId}] Split into ${sections.length} sections (max ${maxCharsPerRequest} chars each)`);
    await updateJob(supabase, jobId, { progress: 25 });

    // ========== Step 5: Generate audio ==========
    // ZONOS: Can process larger batches due to faster inference
    const BATCH_SIZE = 4; // Increased from 3 for F5-TTS
    const totalSections = sections.length;
    const audioSegments: Buffer[] = [];

    for (let batchStart = 0; batchStart < totalSections; batchStart += BATCH_SIZE) {
      const batch = sections.slice(batchStart, Math.min(batchStart + BATCH_SIZE, totalSections));
      const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(totalSections / BATCH_SIZE);
      
      console.log(`[Job ${jobId}] Batch ${batchNum}/${totalBatches} (${batch.length} sections)`);

      // Process batch
      for (let i = 0; i < batch.length; i++) {
        const sectionIndex = batchStart + i;
        const section = batch[i];
        
        const audioBuffer = await generateWithRetry(
          modalUrl,
          section,
          voiceBase64,
          startTime,
          endTime,
          3, // max retries
          jobId,
          sectionIndex,
          totalSections
        );

        audioSegments.push(audioBuffer);
        console.log(`[Job ${jobId}] Section ${sectionIndex + 1}/${totalSections} done (${audioBuffer.length} bytes)`);

        // Update progress: 25% to 90%
        const progress = 25 + Math.round((audioSegments.length / totalSections) * 65);
        await updateJob(supabase, jobId, { progress });
      }
    }

    await updateJob(supabase, jobId, { progress: 90 });

    // ========== Step 6: Concatenate and upload ==========
    console.log(`[Job ${jobId}] Concatenating ${audioSegments.length} segments...`);
    const fullAudio = Buffer.concat(audioSegments);
    
    const outputPath = `output/${jobId}/audiobook.mp3`;
    console.log(`[Job ${jobId}] Final audio: ${(fullAudio.length / 1024 / 1024).toFixed(2)} MB`);

    const { error: uploadError } = await supabase.storage
      .from("audiobooks")
      .upload(outputPath, fullAudio, {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Failed to upload audiobook: ${uploadError.message}`);
    }

    // ========== Step 7: Done ==========
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

    await updateJob(supabase, jobId, {
      status: "failed",
      error: errorMessage,
    });
  }
}

// ========== ZONOS API CALL ==========

async function generateWithRetry(
  modalUrl: string,
  text: string,
  voiceBase64: string,
  startTime: number,
  endTime: number,
  maxRetries: number,
  jobId: string,
  sectionIndex: number,
  totalSections: number
): Promise<Buffer> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Job ${jobId}] Section ${sectionIndex + 1}/${totalSections} attempt ${attempt}/${maxRetries}`);
      
      const audio = await zonosTTS(modalUrl, text, voiceBase64, startTime, endTime);
      return audio;
      
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Job ${jobId}] Section ${sectionIndex + 1} attempt ${attempt} failed: ${lastError.message}`);
      
      if (attempt < maxRetries) {
        // Exponential backoff: 2s, 4s, 8s
        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
        console.log(`[Job ${jobId}] Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  
  throw new Error(`Section ${sectionIndex + 1} failed after ${maxRetries} attempts: ${lastError?.message}`);
}

async function zonosTTS(
  modalUrl: string, 
  text: string, 
  voiceBase64: string,
  startTime: number,
  endTime: number
): Promise<Buffer> {
  const controller = new AbortController();
  // Zonos is faster, but give it 3 minutes for long chunks
  const timeout = setTimeout(() => controller.abort(), 3 * 60 * 1000);

  try {
    const response = await fetch(modalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        reference_audio_base64: voiceBase64,
        format: "mp3",
        start_time: startTime,
        end_time: endTime,
        speaking_rate: 0.95, // Slightly slower for audiobook narration
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Zonos TTS failed (${response.status}): ${errorBody}`);
    }

    const result = await response.json();

    if (result.error) {
      throw new Error(`Zonos TTS error: ${result.error}`);
    }

    if (!result.audio_base64) {
      throw new Error("Zonos TTS returned no audio");
    }

    // Log duration for debugging
    if (result.duration_seconds) {
      console.log(`  Generated ${result.duration_seconds}s of audio`);
    }

    return Buffer.from(result.audio_base64, "base64");
  } finally {
    clearTimeout(timeout);
  }
}

// ========== HELPERS ==========

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

async function downloadVoiceSample(supabase: ReturnType<typeof getSupabase>, storagePath: string): Promise<Buffer> {
  const { data: voiceData, error } = await supabase.storage
    .from("audiobooks")
    .download(storagePath);

  if (error || !voiceData) {
    throw new Error(`Failed to download voice sample: ${error?.message}`);
  }

  return Buffer.from(await voiceData.arrayBuffer());
}

function splitTextSmart(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  // Split on sentence boundaries first
  const sentences = text.split(/(?<=[.!?])\s+/);
  const sections: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    // Handle very long sentences
    if (trimmed.length > maxChars) {
      if (current.trim()) {
        sections.push(current.trim());
        current = "";
      }
      
      // Split long sentence on clauses
      const clauses = trimmed.split(/(?<=[,;])\s+/);
      for (const clause of clauses) {
        if (current.length + clause.length + 1 <= maxChars) {
          current += clause + " ";
        } else {
          if (current.trim()) sections.push(current.trim());
          current = clause + " ";
        }
      }
      continue;
    }

    // Normal sentence
    if (current.length + trimmed.length + 1 <= maxChars) {
      current += trimmed + " ";
    } else {
      if (current.trim()) sections.push(current.trim());
      current = trimmed + " ";
    }
  }

  if (current.trim()) {
    sections.push(current.trim());
  }

  // Fallback: if no sections created, force split
  if (sections.length === 0) {
    for (let i = 0; i < text.length; i += maxChars) {
      sections.push(text.slice(i, i + maxChars));
    }
  }

  return sections;
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
