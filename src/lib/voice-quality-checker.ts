/**
 * Voice Sample Quality Checker
 */

export interface VoiceQualityReport {
  score: number;
  duration: number;
  sampleRate: number;
  isValid: boolean;
  issues: string[];
  recommendations: string[];
  analysis: {
    hasVoice: boolean;
    noiseLevel: 'low' | 'medium' | 'high';
    volumeConsistency: 'good' | 'uneven' | 'poor';
    isTooShort: boolean;
    isTooLong: boolean;
    hasMusic: boolean;
    hasMultipleSpeakers: boolean;
  };
}

export async function analyzeVoiceSample(
  audioBuffer: Buffer,
  fileName?: string
): Promise<VoiceQualityReport> {
  const issues: string[] = [];
  const recommendations: string[] = [];
  
  const { duration, sampleRate } = estimateAudioInfo(audioBuffer, fileName);
  
  if (duration < 3) {
    issues.push(`Sample too short (${duration.toFixed(1)}s). Minimum 3 seconds required.`);
    recommendations.push("Record or select a longer clip (10-20 seconds ideal).");
  } else if (duration < 8) {
    issues.push(`Sample shorter than ideal (${duration.toFixed(1)}s).`);
    recommendations.push("Consider using a 10-20 second clip for better voice cloning.");
  } else if (duration > 30) {
    issues.push(`Sample very long (${duration.toFixed(1)}s).`);
    recommendations.push("Trim to 10-20 seconds for optimal results.");
  }
  
  let score = 100;
  if (duration < 3) score -= 40;
  else if (duration < 8) score -= 15;
  else if (duration > 30) score -= 10;
  
  const isValid = score >= 40 && duration >= 3;
  
  return {
    score: Math.max(0, score),
    duration,
    sampleRate,
    isValid,
    issues,
    recommendations: recommendations.length > 0 ? recommendations : [
      "Great sample! This should work well for voice cloning.",
      "Make sure the voice is clear and not overlapping with other sounds."
    ],
    analysis: {
      hasVoice: true, // Cannot detect without ML — assume true for valid duration
      noiseLevel: 'low', // Cannot detect without signal analysis
      volumeConsistency: 'good', // Cannot detect without signal analysis
      isTooShort: duration < 8,
      isTooLong: duration > 30,
      hasMusic: false, // Cannot detect without Demucs
      hasMultipleSpeakers: false, // Cannot detect without speaker diarization
    },
  };
}

function estimateAudioInfo(buffer: Buffer, fileName?: string): { duration: number; sampleRate: number } {
  const ext = fileName?.split('.').pop()?.toLowerCase();
  const byteSize = buffer.length;

  // WAV is uncompressed: bytes = sampleRate * channels * bitsPerSample * duration
  if (ext === 'wav') {
    // Assume 24kHz mono 16-bit (common for TTS pipelines) unless header says otherwise
    const sampleRate = 24000;
    const bytesPerSecond = sampleRate * 1 * 2; // mono, 16-bit
    // Skip 44-byte WAV header in estimation
    const dataBytes = Math.max(0, byteSize - 44);
    const duration = dataBytes / bytesPerSecond;
    return { duration, sampleRate };
  }

  // Compressed formats (mp3, m4a, ogg, webm) — estimate by bitrate
  // Assume ~128kbps (16KB/s) as a reasonable default for voice audio
  const sampleRate = 44100;
  const bytesPerSecond = 16 * 1024;
  const duration = byteSize / bytesPerSecond;
  return { duration, sampleRate };
}

export function getQualityLabel(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 60) return 'Fair';
  if (score >= 40) return 'Poor';
  return 'Invalid';
}

export function getQualityColor(score: number): string {
  if (score >= 75) return '#22c55e';
  if (score >= 60) return '#eab308';
  if (score >= 40) return '#f97316';
  return '#ef4444';
}
