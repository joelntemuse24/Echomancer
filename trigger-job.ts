import { createClient } from '@supabase/supabase-js';
import { generateAudiobookV2 } from './src/lib/generate-audiobook-v2';

const supabase = createClient(
  'https://oscbxncqbajxojweuubt.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zY2J4bmNxYmFqeG9qd2V1dWJ0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMjkwNSwiZXhwIjoyMDg4Njc4OTA1fQ.LX90GLUX38B2aNsxwaVu_kxo5PBAFKQRFB1aSzFr_Cc'
);

async function triggerJob() {
  const { data: job, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', '38492688-5aac-47a0-bfb4-493645fa6117')
    .single();
  
  if (error || !job) {
    console.log('Job not found:', error);
    return;
  }
  
  console.log(`Triggering job ${job.id.slice(0, 8)}...`);
  console.log(`PDF: ${job.pdf_storage_path}`);
  console.log(`Voice: ${job.voice_storage_path}`);
  
  // Update to processing
  await supabase.from('jobs').update({ status: 'processing', progress: 5 }).eq('id', job.id);
  
  // Start generation
  generateAudiobookV2({
    jobId: job.id,
    pdfStoragePath: job.pdf_storage_path,
    voiceStoragePath: job.voice_storage_path,
    videoId: job.video_id,
    startTime: job.start_time,
    endTime: job.end_time,
  }).catch((err) => {
    console.error(`[Job ${job.id}] Error:`, err);
  });
  
  console.log('✅ Generation started! Check the dashboard for progress.');
}

triggerJob();
