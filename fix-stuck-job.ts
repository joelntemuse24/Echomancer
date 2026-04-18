import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://oscbxncqbajxojweuubt.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zY2J4bmNxYmFqeG9qd2V1dWJ0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMjkwNSwiZXhwIjoyMDg4Njc4OTA1fQ.LX90GLUX38B2aNsxwaVu_kxo5PBAFKQRFB1aSzFr_Cc'
);

async function fixStuckJob() {
  const { data: job } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'processing')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  
  if (!job) {
    console.log('No processing job found');
    return;
  }
  
  console.log(`Marking job ${job.id.slice(0, 8)}... as failed due to TTS server timeout`);
  
  const { error } = await supabase
    .from('jobs')
    .update({
      status: 'failed',
      error: 'TTS server timeout - please retry. Server has been restarted.',
      updated_at: new Date().toISOString()
    })
    .eq('id', job.id);
  
  if (error) {
    console.error('Failed to update job:', error);
  } else {
    console.log('Job updated. You can now retry from the dashboard.');
  }
}

fixStuckJob();
