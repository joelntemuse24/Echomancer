import * as https from "https";
import * as http from "http";

const modalUrl = process.env.MODAL_TTS_URL || "https://ntemusejoel--f5-tts-fixed-f5ttsserver-generate.modal.run";

console.log("Testing Modal TTS endpoint:", modalUrl);

// Simple test with minimal data
const testPayload = JSON.stringify({
  text: "Hello, this is a test.",
  reference_audio_base64: "", // Will fail but we'll see if server responds
  format: "mp3",
  speed: 1.0,
});

const urlObj = new URL(modalUrl);
const isHttps = urlObj.protocol === "https:";
const requestModule = isHttps ? https : http;

const options = {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(testPayload),
  },
  timeout: 30_000,
};

const startTime = Date.now();

const req = requestModule.request(urlObj, options, (res) => {
  const chunks: Buffer[] = [];
  
  res.on("data", (chunk) => chunks.push(chunk));
  
  res.on("end", () => {
    const responseBuffer = Buffer.concat(chunks);
    const responseText = responseBuffer.toString('utf-8');
    const elapsed = Date.now() - startTime;
    
    console.log(`\nStatus: ${res.statusCode}`);
    console.log(`Response time: ${elapsed}ms`);
    console.log(`Response: ${responseText.substring(0, 500)}`);
  });
});

req.on("error", (err) => {
  console.error("Request failed:", err.message);
});

req.on("timeout", () => {
  console.error("Request timed out after 30 seconds");
  req.destroy();
});

req.write(testPayload);
req.end();

console.log("Request sent, waiting for response...");
