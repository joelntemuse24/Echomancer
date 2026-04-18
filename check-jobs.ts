import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://oscbxncqbajxojweuubt.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zY2J4bmNxYmFqeG9qd2V1dWJ0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzEwMjkwNSwiZXhwIjoyMDg4Njc4OTA1fQ.LX90GLUX38B2aNsxwaVu_kxo5PBAFKQRFB1aSzFr_Cc'
);

async function checkJobs() {
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);
  
  if (error) {
    console.log('Error:', error);
    return;
  }
  
  console.log('=== Recent Jobs ===');
  jobs?.forEach((job, i) => {
    console.log(`${i+1}. ${job.id.slice(0,8)}... | Status: ${job.status} | Progress: ${job.progress}% | Created: ${job.created_at}`);
    if (job.error_message) {
      console.log(`   ERROR: ${job.error_message}`);
    }
  });
}

checkJobs();
