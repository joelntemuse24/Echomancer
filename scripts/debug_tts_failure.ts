import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log('Investigating TTS generation failures...\n');
  
  // Get the failed job details
  const jobId = '84f12a38-bb70-4b1f-9ac4-ac770ceb0797';
  
  const { data: job, error: jobError } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single();
    
  if (jobError) {
    console.error('Error fetching job:', jobError);
    return;
  }
  
  console.log(`Job ${jobId} details:`);
  console.log(`  Title: ${job.book_title}`);
  console.log(`  Status: ${job.status}`);
  console.log(`  Progress: ${job.progress}%`);
  console.log(`  Error: ${job.error || 'None'}`);
  console.log(`  Created: ${job.created_at}`);
  console.log(`  Updated: ${job.updated_at}`);
  console.log(`  PDF Path: ${job.pdf_path || 'None'}`);
  console.log(`  Voice ID: ${job.voice_id || 'None'}`);
  
  // Check Modal TTS server status
  console.log('\nChecking Modal TTS servers...');
  
  const f5Url = process.env.MODAL_F5_TTS_URL;
  const zonosUrl = process.env.MODAL_ZONOS_URL;
  
  if (f5Url) {
    try {
      const response = await fetch(f5Url, { 
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      console.log(`F5-TTS Server: ${response.status} ${response.statusText}`);
    } catch (e) {
      console.log(`F5-TTS Server: Error - ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.log('F5-TTS Server: URL not configured');
  }
  
  if (zonosUrl) {
    try {
      const response = await fetch(zonosUrl, { 
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      console.log(`Zonos Server: ${response.status} ${response.statusText}`);
    } catch (e) {
      console.log(`Zonos Server: Error - ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.log('Zonos Server: URL not configured');
  }
  
  // Check LLM Director
  const llmUrl = process.env.MODAL_LLM_DIRECTOR_URL;
  if (llmUrl) {
    try {
      const response = await fetch(llmUrl, { 
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      console.log(`LLM Director: ${response.status} ${response.statusText}`);
    } catch (e) {
      console.log(`LLM Director: Error - ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.log('LLM Director: URL not configured');
  }
  
  // Check if there are any logs or error patterns in recent jobs
  console.log('\nAnalyzing recent job patterns...');
  
  const { data: recentJobs, error: recentError } = await supabase
    .from('jobs')
    .select('id, status, progress, error, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(20);
    
  if (recentError) {
    console.error('Error fetching recent jobs:', recentError);
    return;
  }
  
  const failedJobs = recentJobs?.filter(j => j.status === 'failed') || [];
  const successfulJobs = recentJobs?.filter(j => j.status === 'ready' && j.progress === 100) || [];
  
  console.log(`Recent jobs analysis:`);
  console.log(`  Total: ${recentJobs?.length || 0}`);
  console.log(`  Failed: ${failedJobs.length}`);
  console.log(`  Successful: ${successfulJobs.length}`);
  
  if (failedJobs.length > 0) {
    console.log('\nFailed job errors:');
    failedJobs.forEach(job => {
      console.log(`  ${job.id}: ${job.error || 'No error message'}`);
    });
  }
  
  // Check environment variables
  console.log('\nEnvironment variables check:');
  console.log(`  MODAL_F5_TTS_URL: ${f5Url ? 'Set' : 'Not set'}`);
  console.log(`  MODAL_ZONOS_URL: ${zonosUrl ? 'Set' : 'Not set'}`);
  console.log(`  MODAL_LLM_DIRECTOR_URL: ${llmUrl ? 'Set' : 'Not set'}`);
  console.log(`  NEXT_PUBLIC_SUPABASE_URL: ${process.env.NEXT_PUBLIC_SUPABASE_URL ? 'Set' : 'Not set'}`);
}

main();
