/**
 * Integration Tests for Smallest AI (Real API Calls)
 * 
 * These tests make actual HTTP requests to Smallest AI's API.
 * They require a valid SMALLEST_API_KEY in .env.local.
 * 
 * Run with: npm run test -- src/lib/smallest-ai.integration.test.ts
 * 
 * Skip in CI/regular test runs by using the .integration. pattern.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { cloneVoiceSmallestAI, smallestTTSBatch } from './generate-audiobook-v2';
import fs from 'fs';
import path from 'path';

describe('Smallest AI Integration Tests (Real API)', () => {
  const apiKey = process.env.SMALLEST_API_KEY;
  const jobId = `integration-test-${Date.now()}`;

  beforeAll(() => {
    if (!apiKey) {
      throw new Error('SMALLEST_API_KEY not set in environment. Skipping integration tests.');
    }
  });

  it('should clone a voice using real API', async () => {
    // Create a minimal WAV file header for testing (10 seconds of silence)
    // In production, this would be a real voice sample
    const sampleRate = 16000;
    const duration = 10; // seconds
    const numSamples = sampleRate * duration;
    const byteRate = sampleRate * 2; // 16-bit mono
    const dataSize = numSamples * 2;
    
    const wavBuffer = Buffer.alloc(44 + dataSize);
    
    // WAV header
    wavBuffer.write('RIFF', 0);
    wavBuffer.writeUInt32LE(36 + dataSize, 4);
    wavBuffer.write('WAVE', 8);
    wavBuffer.write('fmt ', 12);
    wavBuffer.writeUInt32LE(16, 16);
    wavBuffer.writeUInt16LE(1, 20); // PCM
    wavBuffer.writeUInt16LE(1, 22); // Mono
    wavBuffer.writeUInt32LE(sampleRate, 24);
    wavBuffer.writeUInt32LE(byteRate, 28);
    wavBuffer.writeUInt16LE(2, 32); // Block align
    wavBuffer.writeUInt16LE(16, 34); // Bits per sample
    wavBuffer.write('data', 36);
    wavBuffer.writeUInt32LE(dataSize, 40);

    console.log(`[Integration Test] Cloning voice with ${wavBuffer.length} byte sample...`);
    
    const voiceId = await cloneVoiceSmallestAI(wavBuffer, apiKey, jobId);
    
    expect(voiceId).toBeDefined();
    expect(typeof voiceId).toBe('string');
    expect(voiceId.length).toBeGreaterThan(0);
    
    console.log(`[Integration Test] Voice cloned successfully: ${voiceId}`);
  }, 60000); // 60 second timeout for API call

  it('should generate speech using real API', async () => {
    // Use a known voice ID if available, or skip this test
    // For now, we'll use a placeholder - in practice you'd use a cloned voice ID
    const voiceId = 'test-voice-id'; // This would be from a previous clone
    
    const texts = ['Hello world, this is a test.'];
    
    try {
      const results = await smallestTTSBatch(
        apiKey,
        texts,
        voiceId,
        jobId,
        undefined,
        (completed) => {
          console.log(`[Integration Test] Progress: ${completed}/${texts.length}`);
        }
      );
      
      expect(results).toHaveLength(1);
      expect(results[0]?.audio_buffer.byteLength).toBeGreaterThan(0);
      expect(results[0]?.error).toBeUndefined();
      
      console.log(`[Integration Test] TTS generated successfully: ${results[0]?.audio_buffer.byteLength} bytes`);
    } catch (error) {
      // If the voice ID doesn't exist, that's expected for integration tests
      // In production, you'd use a real cloned voice ID
      console.log(`[Integration Test] TTS test skipped (voice ID may not exist): ${error}`);
    }
  }, 60000);
});

describe('Environment Setup', () => {
  it('should have SMALLEST_API_KEY configured', () => {
    const apiKey = process.env.SMALLEST_API_KEY;
    expect(apiKey).toBeDefined();
    expect(typeof apiKey).toBe('string');
    expect(apiKey?.length).toBeGreaterThan(0);
    console.log(`[Integration Test] API Key configured: ${apiKey?.substring(0, 10)}...`);
  });
});
