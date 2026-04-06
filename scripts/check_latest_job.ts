import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error('Error fetching jobs:', error);
    return;
  }

  console.log('Latest 5 jobs:');
  for (const job of data) {
    console.log(`\nJob ID: ${job.id}`);
    console.log(`Title: ${job.book_title}`);
    console.log(`Status: ${job.status}`);
    console.log(`Progress: ${job.progress}%`);
    console.log(`Storage Path: ${job.audio_storage_path}`);
    console.log(`Created: ${job.created_at}`);
    
    if (job.audio_storage_path) {
      const { data: storageData, error: storageError } = await supabase.storage
        .from('audiobooks')
        .createSignedUrl(job.audio_storage_path, 60);
        
      if (storageError) {
        console.log(`  -> Storage Error: ${storageError.message}`);
      } else {
        console.log(`  -> File accessible. URL generated.`);
        // Let's check file size using a HEAD request
        try {
          const res = await fetch(storageData.signedUrl, { method: 'HEAD' });
          console.log(`  -> File size: ${res.headers.get('content-length')} bytes`);
          console.log(`  -> Content type: ${res.headers.get('content-type')}`);
        } catch (e) {
          console.log(`  -> Error checking file size:`, e);
        }
      }
    }
  }
}

main();
