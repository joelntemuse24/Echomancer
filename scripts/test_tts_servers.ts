import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function testTTSServers() {
  console.log('Testing TTS servers...\n');
  
  const f5Url = process.env.MODAL_F5_TTS_URL;
  const zonosUrl = process.env.MODAL_ZONOS_URL;
  
  // Test F5-TTS
  if (f5Url) {
    console.log('Testing F5-TTS server...');
    try {
      const response = await fetch(f5Url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: "Hello world, this is a test.",
          reference_audio_base64: null,
          format: "mp3",
          speed: 1.0
        }),
        signal: AbortSignal.timeout(30000)
      });
      
      if (response.ok) {
        const result = await response.json();
        if (result.audio_base64) {
          console.log('✅ F5-TTS working - generated audio');
        } else {
          console.log('❌ F5-TTS response missing audio');
        }
      } else {
        const error = await response.text();
        console.log(`❌ F5-TTS failed: ${response.status} - ${error.substring(0, 200)}`);
      }
    } catch (e) {
      console.log(`❌ F5-TTS error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  // Test Zonos
  if (zonosUrl) {
    console.log('\nTesting Zonos server...');
    try {
      const response = await fetch(zonosUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: "Hello world, this is a test.",
          reference_audio_base64: null,
          format: "mp3",
          speed: 1.0
        }),
        signal: AbortSignal.timeout(30000)
      });
      
      if (response.ok) {
        const result = await response.json();
        if (result.audio_base64) {
          console.log('✅ Zonos working - generated audio');
        } else {
          console.log('❌ Zonos response missing audio');
        }
      } else {
        const error = await response.text();
        console.log(`❌ Zonos failed: ${response.status} - ${error.substring(0, 200)}`);
      }
    } catch (e) {
      console.log(`❌ Zonos error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

testTTSServers();
