import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const jobId = '84f12a38-bb70-4b1f-9ac4-ac770ceb0797';
  
  console.log(`Checking generation logs for job ${jobId}...`);
  
  // Check if there are any individual audio chunks in storage
  const { data: files, error: listError } = await supabase.storage
    .from('audiobooks')
    .list(`output/${jobId}`, {
      limit: 100
    });
  
  if (listError) {
    console.error('Error listing files:', listError);
    return;
  }
  
  console.log(`Files in storage for job ${jobId}:`);
  if (!files || files.length === 0) {
    console.log('  No files found');
  } else {
    files.forEach(file => {
      console.log(`  - ${file.name} (${(file as {size?: number}).size || 'unknown'} bytes)`);
    });
  }
  
  // Check job status and error
  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single();
    
  if (jobError) {
    console.error('Error fetching job:', jobError);
    return;
  }
  
  console.log(`\nJob details:`);
  console.log(`  Status: ${job.status}`);
  console.log(`  Progress: ${job.progress}%`);
  console.log(`  Error: ${job.error || 'None'}`);
  console.log(`  Storage Path: ${job.audio_storage_path || 'None'}`);
  console.log(`  Created: ${job.created_at}`);
  console.log(`  Updated: ${job.updated_at}`);
  
  // Check if there might be chunks with different naming pattern
  const { data: allFiles, error: allFilesError } = await supabase.storage
    .from('audiobooks')
    .list('', {
      limit: 1000,
      search: jobId
    });
  
  if (allFilesError) {
    console.error('Error searching all files:', allFilesError);
    return;
  }
  
  console.log(`\nAll files containing job ID:`);
  if (!allFiles || allFiles.length === 0) {
    console.log('  No files found with job ID');
  } else {
    allFiles.forEach(file => {
      console.log(`  - ${file.name} (${(file as {size?: number}).size || 'unknown'} bytes)`);
    });
  }
}

main();
