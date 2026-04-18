import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://oscbxncqbajxojweuubt.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zY2J4bmNxYmFqeG9qd2V1dWJ0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMjkwNSwiZXhwIjoyMDg4Njc4OTA1fQ.LX90GLUX38B2aNsxwaVu_kxo5PBAFKQRFB1aSzFr_Cc'
);

async function checkLatestFailed() {
  const { data: job } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'failed')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();
  
  if (!job) {
    console.log('No failed job found');
    return;
  }
  
  console.log('=== Latest Failed Job ===');
  console.log(`ID: ${job.id}`);
  console.log(`Status: ${job.status}`);
  console.log(`Progress: ${job.progress}%`);
  console.log(`Error: ${job.error_message || 'None'}`);
  console.log(`Created: ${job.created_at}`);
  console.log(`Updated: ${job.updated_at}`);
}

checkLatestFailed();
