import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://oscbxncqbajxojweuubt.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zY2J4bmNxYmFqeG9qd2V1dWJ0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMjkwNSwiZXhwIjoyMDg4Njc4OTA1fQ.LX90GLUX38B2aNsxwaVu_kxo5PBAFKQRFB1aSzFr_Cc'
);

async function checkJobDetail() {
  // Get the latest processing job
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
  
  console.log('=== Job Detail ===');
  console.log(`ID: ${job.id}`);
  console.log(`Status: ${job.status}`);
  console.log(`Progress: ${job.progress}%`);
  console.log(`Created: ${job.created_at}`);
  console.log(`Updated: ${job.updated_at}`);
  console.log(`Error: ${job.error_message || 'None'}`);
  
  // Check checkpoints
  const { data: checkpoints } = await supabase
    .from('job_checkpoints')
    .select('*')
    .eq('job_id', job.id)
    .order('chunk_index', { ascending: true });
  
  console.log(`\n=== Checkpoints: ${checkpoints?.length || 0} ===`);
  checkpoints?.forEach((cp, i) => {
    console.log(`  ${i+1}. Chunk ${cp.chunk_index} - ${cp.status}`);
  });
}

checkJobDetail();
