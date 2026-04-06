import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log('Checking all recent jobs and their audio files...');
  
  // Get recent jobs
  const { data: jobs, error: jobsError } = await supabase
    .from('jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);
    
  if (jobsError) {
    console.error('Error fetching jobs:', jobsError);
    return;
  }
  
  console.log(`Found ${jobs?.length || 0} recent jobs:\n`);
  
  for (const job of jobs || []) {
    console.log(`Job ${job.id}:`);
    console.log(`  Title: ${job.book_title}`);
    console.log(`  Status: ${job.status}`);
    console.log(`  Progress: ${job.progress}%`);
    console.log(`  Storage Path: ${job.audio_storage_path || 'None'}`);
    console.log(`  Created: ${job.created_at}`);
    
    if (job.audio_storage_path) {
      // Check if file actually exists
      try {
        const { data, error } = await supabase.storage
          .from('audiobooks')
          .createSignedUrl(job.audio_storage_path, 60);
          
        if (error) {
          console.log(`  ❌ File not accessible: ${error.message}`);
        } else {
          // Try to get file size
          try {
            const response = await fetch(data.signedUrl, { method: 'HEAD' });
            const size = response.headers.get('content-length');
            console.log(`  ✅ File accessible (${size || 'unknown'} bytes)`);
          } catch (e) {
            console.log(`  ⚠️  File URL generated but fetch failed`);
          }
        }
      } catch (e) {
        console.log(`  ❌ Error checking file: ${e}`);
      }
    } else {
      console.log(`  ❌ No storage path`);
    }
    
    console.log('');
  }
  
  // Check all files in storage
  console.log('\nChecking all files in audiobooks storage...');
  const { data: allFiles, error: listError } = await supabase.storage
    .from('audiobooks')
    .list('', { limit: 100 });
    
  if (listError) {
    console.error('Error listing storage:', listError);
    return;
  }
  
  console.log(`Total files in storage: ${allFiles?.length || 0}`);
  if (allFiles && allFiles.length > 0) {
    console.log('Recent files:');
    allFiles.slice(-10).forEach(file => {
      console.log(`  - ${file.name} (${(file as {size?: number}).size || 'unknown'} bytes, modified: ${file.updated_at})`);
    });
  }
}

main();
