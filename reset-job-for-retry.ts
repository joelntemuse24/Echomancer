import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://oscbxncqbajxojweuubt.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zY2J4bmNxYmFqeG9qd2V1dWJ0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMjkwNSwiZXhwIjoyMDg4Njc4OTA1fQ.LX90GLUX38B2aNsxwaVu_kxo5PBAFKQRFB1aSzFr_Cc'
);

async function resetJob() {
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
  
  console.log(`Resetting job ${job.id.slice(0, 8)}... for retry`);
  
  const { error } = await supabase
    .from('jobs')
    .update({
      status: 'queued',
      progress: 0,
      error: null,
      updated_at: new Date().toISOString()
    })
    .eq('id', job.id);
  
  if (error) {
    console.error('Failed to reset job:', error);
  } else {
    console.log('Job reset to "queued". It will start processing automatically.');
  }
}

resetJob();
