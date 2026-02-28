import { task, logger } from "@trigger.dev/sdk/v3";
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";

// Initialize clients inside the task to use env vars at runtime
function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function getReplicate() {
  return new Replicate({ auth: process.env.REPLICATE_API_TOKEN! });
}

interface GenerateAudiobookPayload {
  jobId: string;
  pdfStoragePath: string;
  voiceStoragePath: string | null;
  videoId: string | null;
  startTime: number;
  endTime: number;
}

export const generateAudiobook = task({
  id: "generate-audiobook",
  maxDuration: 1800, // 30 minutes max
  retry: { maxAttempts: 2 },
  run: async (payload: GenerateAudiobookPayload) => {
    const { jobId, pdfStoragePath, voiceStoragePath, videoId, startTime, endTime } = payload;
    const supabase = getSupabase();
    const replicate = getReplicate();

    try {
      // ========== Step 1: Update status to processing ==========
      await updateJob(supabase, jobId, { status: "processing", progress: 5 });
      logger.info("Job started", { jobId });

      // ========== Step 2: Download PDF and extract text ==========
      await updateJob(supabase, jobId, { progress: 10 });
      logger.info("Downloading PDF...");

      const { data: pdfData, error: pdfError } = await supabase.storage
        .from("audiobooks")
        .download(pdfStoragePath);

      if (pdfError || !pdfData) {
        throw new Error(`Failed to download PDF: ${pdfError?.message}`);
      }

      // Extract text from PDF using a simple approach
      // In production, you'd use a proper PDF parser library
      const pdfBuffer = Buffer.from(await pdfData.arrayBuffer());
      const text = extractTextFromPdfBuffer(pdfBuffer);

      if (!text.trim()) {
        throw new Error("Could not extract text from PDF. Is it a scanned document?");
      }

      logger.info(`Extracted ${text.length} characters from PDF`);
      await updateJob(supabase, jobId, { progress: 25 });

      // ========== Step 3: Get voice sample ==========
      let voiceFileUrl: string;

      if (voiceStoragePath) {
        // Direct upload — get public URL from Supabase Storage
        const { data: urlData } = supabase.storage
          .from("audiobooks")
          .getPublicUrl(voiceStoragePath);
        voiceFileUrl = urlData.publicUrl;
      } else if (videoId) {
        // YouTube video — we need to download audio server-side
        // For Trigger.dev, we pass the video ID and use yt-dlp or a proxy
        // For now, this is a placeholder — in production you'd use a service
        throw new Error(
          "YouTube audio extraction requires yt-dlp. Please upload a voice sample directly for now."
        );
      } else {
        throw new Error("No voice sample provided");
      }

      logger.info("Voice sample URL obtained", { voiceFileUrl });
      await updateJob(supabase, jobId, { progress: 35 });

      // ========== Step 4: Split text into chunks and generate audio ==========
      const maxChunkChars = 4000;
      const chunks = splitText(text, maxChunkChars);
      logger.info(`Processing ${chunks.length} text chunks`);

      const audioSegments: Buffer[] = [];
      const f5ttsModel = process.env.F5TTS_MODEL ||
        "x-lance/f5-tts:87faf6dd7a692dd82043f662e76369cab126a2cf1937e25a9d41e0b834fd230e";

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkProgress = 35 + Math.floor(((i + 1) / chunks.length) * 50);

        logger.info(`Processing chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`);

        // Call F5-TTS via Replicate
        const output = await replicate.run(f5ttsModel as `${string}/${string}:${string}`, {
          input: {
            gen_text: chunk,
            ref_audio: voiceFileUrl,
            ref_text: "",
            model_type: "F5-TTS",
            remove_silence: true,
          },
        });

        // Download the generated audio
        let audioUrl: string;
        if (typeof output === "string") {
          audioUrl = output;
        } else if (output && typeof output === "object" && "url" in output) {
          audioUrl = (output as { url: string }).url;
        } else {
          audioUrl = String(output);
        }

        const audioRes = await fetch(audioUrl);
        if (!audioRes.ok) {
          throw new Error(`Failed to download generated audio for chunk ${i + 1}`);
        }
        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
        audioSegments.push(audioBuffer);

        await updateJob(supabase, jobId, { progress: chunkProgress });
      }

      // ========== Step 5: Concatenate audio and upload ==========
      await updateJob(supabase, jobId, { progress: 90 });
      logger.info("Concatenating audio segments...");

      const fullAudio = Buffer.concat(audioSegments);
      const outputPath = `output/${jobId}/audiobook.wav`;

      const { error: uploadError } = await supabase.storage
        .from("audiobooks")
        .upload(outputPath, fullAudio, {
          contentType: "audio/wav",
          upsert: true,
        });

      if (uploadError) {
        throw new Error(`Failed to upload audiobook: ${uploadError.message}`);
      }

      // ========== Step 6: Mark job as complete ==========
      await updateJob(supabase, jobId, {
        status: "ready",
        progress: 100,
        audio_storage_path: outputPath,
      });

      logger.info("Audiobook generation complete!", { jobId, outputPath });
      return { success: true, jobId, outputPath };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Audiobook generation failed", { jobId, error: errorMessage });

      await updateJob(supabase, jobId, {
        status: "failed",
        error: errorMessage,
      });

      throw error;
    }
  },
});

// ========== Helper functions ==========

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function updateJob(
  supabase: any,
  jobId: string,
  updates: Record<string, unknown>
) {
  const { error } = await supabase
    .from("jobs")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", jobId);

  if (error) {
    logger.warn("Failed to update job status", { jobId, error: error.message });
  }
}

function splitText(text: string, maxChars: number): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    if (current.length + sentence.length + 1 <= maxChars) {
      current += sentence + " ";
    } else {
      if (current.trim()) chunks.push(current.trim());
      current = sentence + " ";
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.length > 0 ? chunks : [text.slice(0, maxChars)];
}

function extractTextFromPdfBuffer(buffer: Buffer): string {
  // Simple text extraction from PDF buffer
  // This extracts text between BT...ET blocks and decodes basic PDF strings
  // In production, use a proper library like pdf-parse
  const content = buffer.toString("latin1");
  const textBlocks: string[] = [];

  // Match text between parentheses in BT...ET blocks
  const btEtRegex = /BT\s*([\s\S]*?)ET/g;
  let match;

  while ((match = btEtRegex.exec(content)) !== null) {
    const block = match[1];
    const textRegex = /\(([^)]*)\)/g;
    let textMatch;
    while ((textMatch = textRegex.exec(block)) !== null) {
      const decoded = textMatch[1]
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/\\\\/g, "\\");
      if (decoded.trim()) {
        textBlocks.push(decoded);
      }
    }
  }

  // If BT/ET extraction fails, try a simpler approach
  if (textBlocks.length === 0) {
    const simpleRegex = /\(([^)]{2,})\)/g;
    while ((match = simpleRegex.exec(content)) !== null) {
      const text = match[1].replace(/[^\x20-\x7E\n\r\t]/g, " ").trim();
      if (text.length > 5) {
        textBlocks.push(text);
      }
    }
  }

  return textBlocks.join(" ").replace(/\s+/g, " ").trim();
}
