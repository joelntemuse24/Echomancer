import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const jobId = '84f12a38-bb70-4b1f-9ac4-ac770ceb0797'; // Latest job with missing file
  
  console.log(`Checking chunks for job ${jobId}...`);
  
  const { data: chunks, error: chunksError } = await supabase
    .from("job_checkpoints")
    .select("audio_path, section_index")
    .eq("job_id", jobId)
    .order("section_index", { ascending: true });

  if (chunksError) {
    console.error('Error fetching chunks:', chunksError);
    return;
  }

  if (!chunks || chunks.length === 0) {
    console.log('No chunks found for this job');
    return;
  }

  console.log(`Found ${chunks.length} chunks:`);
  for (const chunk of chunks) {
    console.log(`  Section ${chunk.section_index}: ${chunk.audio_path}`);
    
    // Check if chunk file exists and get its size
    const { data: storageData, error: storageError } = await supabase.storage
      .from('audiobooks')
      .createSignedUrl(chunk.audio_path, 60);
      
    if (storageError) {
      console.log(`    -> Chunk missing: ${storageError.message}`);
    } else {
      try {
        const res = await fetch(storageData.signedUrl, { method: 'HEAD' });
        console.log(`    -> Chunk size: ${res.headers.get('content-length')} bytes`);
        console.log(`    -> Content type: ${res.headers.get('content-type')}`);
      } catch (e) {
        console.log(`    -> Error checking chunk:`, e);
      }
    }
  }
}

main();
