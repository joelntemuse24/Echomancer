import * as https from "https";
import * as fs from "fs";

// Test the F5-TTS v2 endpoint
const modalUrl = "https://ntemusejoel--f5-tts-v2-f5ttsserver-generate.modal.run";

// Create a simple test wav file (1 second of silence as base64)
const testAudioBase64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA="; // minimal WAV

const payload = JSON.stringify({
  text: "Hello, this is a test of the F5 TTS system.",
  reference_audio_base64: testAudioBase64,
  format: "mp3",
  speed: 1.0,
});

console.log("Testing F5-TTS v2 endpoint...");
console.log("URL:", modalUrl);

const urlObj = new URL(modalUrl);

const options = {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  },
  timeout: 120_000, // 2 minute timeout
};

const startTime = Date.now();

const req = https.request(urlObj, options, (res) => {
  const chunks: Buffer[] = [];
  
  res.on("data", (chunk) => chunks.push(chunk));
  
  res.on("end", () => {
    const responseBuffer = Buffer.concat(chunks);
    const responseText = responseBuffer.toString('utf-8');
    const elapsed = Date.now() - startTime;
    
    console.log(`\nStatus: ${res.statusCode}`);
    console.log(`Response time: ${elapsed}ms`);
    
    try {
      const result = JSON.parse(responseText);
      if (result.error) {
        console.log("Error:", result.error);
      } else if (result.audio_base64) {
        console.log("Success! Audio generated:");
        console.log(`  Format: ${result.format}`);
        console.log(`  Size: ${result.size} bytes`);
        console.log(`  Sample Rate: ${result.sample_rate}`);
        
        // Save to file
        const audioBuffer = Buffer.from(result.audio_base64, "base64");
        fs.writeFileSync("test_output.mp3", audioBuffer);
        console.log("  Saved to: test_output.mp3");
      }
    } catch (e) {
      console.log("Response:", responseText.substring(0, 500));
    }
  });
});

req.on("error", (err) => {
  console.error("Request failed:", err.message);
});

req.on("timeout", () => {
  console.error("Request timed out");
  req.destroy();
});

req.write(payload);
req.end();
