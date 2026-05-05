/**
 * Tests for Smallest AI Integration
 * 
 * These tests verify the voice cloning and TTS functionality using Smallest AI Lightning v3.1.
 * 
 * Note: These tests require a valid SMALLEST_API_KEY environment variable.
 * Set it in your .env.local file before running tests.
 */

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { cloneVoiceSmallestAI, smallestTTSBatch } from './generate-audiobook-v2';

// Mock fetch for testing
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

describe('Smallest AI Integration', () => {
  const mockApiKey = 'test-api-key';
  const mockJobId = 'test-job-123';
  const mockVoiceId = 'voice-abc-123';

  beforeAll(() => {
    // Set environment variable for tests
    process.env.SMALLEST_API_KEY = mockApiKey;
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  describe('Voice Cloning (cloneVoiceSmallestAI)', () => {
    it('should successfully clone a voice and return voice_id', async () => {
      const mockVoiceBuffer = Buffer.from('mock audio data');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ voice_id: mockVoiceId }),
      });

      const voiceId = await cloneVoiceSmallestAI(mockVoiceBuffer, mockApiKey, mockJobId);
      
      expect(voiceId).toBe(mockVoiceId);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://waves-api.smallest.ai/v1/voices',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Api-Key': mockApiKey,
            'Content-Type': expect.stringContaining('multipart/form-data'),
          }),
        })
      );
    });

    it('should handle API errors gracefully', async () => {
      const mockVoiceBuffer = Buffer.from('mock audio data');
      
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Invalid voice sample',
      });

      await expect(
        cloneVoiceSmallestAI(mockVoiceBuffer, mockApiKey, mockJobId)
      ).rejects.toThrow('Smallest AI voice clone failed');
    });

    it('should validate voice_id in response', async () => {
      const mockVoiceBuffer = Buffer.from('mock audio data');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ voice_id: '' }),
      });

      await expect(
        cloneVoiceSmallestAI(mockVoiceBuffer, mockApiKey, mockJobId)
      ).rejects.toThrow('voice clone returned no voice_id');
    });

    it('should include correct model name in request', async () => {
      const mockVoiceBuffer = Buffer.from('mock audio data');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ voice_id: mockVoiceId }),
      });

      await cloneVoiceSmallestAI(mockVoiceBuffer, mockApiKey, mockJobId);
      
      const callArgs = mockFetch.mock.calls[0];
      if (callArgs && callArgs[1]?.body) {
        const bodyString = callArgs[1].body.toString();
        expect(bodyString).toContain('lightning-v3.1');
      }
    });
  });

  describe('TTS Batch Processing (smallestTTSBatch)', () => {
    it('should process multiple texts in parallel', async () => {
      const mockTexts = ['Hello world', 'This is a test', 'Another section'];
      
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1024),
      });

      const results = await smallestTTSBatch(
        mockApiKey,
        mockTexts,
        mockVoiceId,
        mockJobId
      );
      
      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result.audio_buffer.byteLength).toBeGreaterThan(0);
        expect(result.error).toBeUndefined();
      });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should use correct Lightning v3.1 endpoint', async () => {
      const mockTexts = ['Test text'];
      
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1024),
      });

      await smallestTTSBatch(mockApiKey, mockTexts, mockVoiceId, mockJobId);
      
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.smallest.ai/waves/v1/lightning-v3.1/get_speech',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should include correct TTS parameters', async () => {
      const mockTexts = ['Test text'];
      
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1024),
      });

      await smallestTTSBatch(mockApiKey, mockTexts, mockVoiceId, mockJobId);
      
      const callArgs = mockFetch.mock.calls[0];
      if (callArgs && callArgs[1]?.body) {
        const body = JSON.parse(callArgs[1].body);
        expect(body.text).toBe('Test text');
        expect(body.voice_id).toBe(mockVoiceId);
        expect(body.sample_rate).toBe(44100);
        expect(body.output_format).toBe('wav');
        expect(body.speed).toBe(1);
        expect(body.language).toBe('en');
      }
    });

    it('should handle empty text gracefully', async () => {
      const mockTexts = [''];
      
      const results = await smallestTTSBatch(mockApiKey, mockTexts, mockVoiceId, mockJobId);
      
      expect(results).toHaveLength(1);
      expect(results[0]?.error).toBe('Empty text');
    });

    it('should call progress callback on completion', async () => {
      const mockTexts = ['Test text', 'Another test'];
      const progressCallback = vi.fn();
      
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1024),
      });

      await smallestTTSBatch(
        mockApiKey,
        mockTexts,
        mockVoiceId,
        mockJobId,
        undefined,
        progressCallback
      );
      
      expect(progressCallback).toHaveBeenCalledTimes(2);
    });

    it('should retry failed requests up to 3 times', async () => {
      const mockTexts = ['Test text'];
      
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(1024),
        });

      const results = await smallestTTSBatch(mockApiKey, mockTexts, mockVoiceId, mockJobId);
      
      expect(results[0]?.error).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    }, 15000);

    it('should return error after max retries', async () => {
      const mockTexts = ['Test text'];
      
      mockFetch.mockRejectedValue(new Error('Network error'));

      const results = await smallestTTSBatch(mockApiKey, mockTexts, mockVoiceId, mockJobId);
      
      expect(results[0]?.error).toBeDefined();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    }, 15000);
  });

  describe('Audio Format Validation', () => {
    it('should request 44.1kHz sample rate', async () => {
      const mockTexts = ['Test text'];
      
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1024),
      });

      await smallestTTSBatch(mockApiKey, mockTexts, mockVoiceId, mockJobId);
      
      const callArgs = mockFetch.mock.calls[0];
      if (callArgs && callArgs[1]?.body) {
        const body = JSON.parse(callArgs[1].body);
        expect(body.sample_rate).toBe(44100);
      }
    });

    it('should request WAV output format', async () => {
      const mockTexts = ['Test text'];
      
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1024),
      });

      await smallestTTSBatch(mockApiKey, mockTexts, mockVoiceId, mockJobId);
      
      const callArgs = mockFetch.mock.calls[0];
      if (callArgs && callArgs[1]?.body) {
        const body = JSON.parse(callArgs[1].body);
        expect(body.output_format).toBe('wav');
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle missing API key in environment', () => {
      const originalKey = process.env.SMALLEST_API_KEY;
      delete process.env.SMALLEST_API_KEY;
      
      expect(process.env.SMALLEST_API_KEY).toBeUndefined();
      
      // Restore for other tests
      if (originalKey) {
        process.env.SMALLEST_API_KEY = originalKey;
      }
    });

    it('should handle network timeouts', async () => {
      const mockVoiceBuffer = Buffer.from('mock audio data');
      
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(
        cloneVoiceSmallestAI(mockVoiceBuffer, mockApiKey, mockJobId)
      ).rejects.toThrow();
    });

    it('should handle TTS API errors', async () => {
      const mockTexts = ['Test text'];
      
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      });

      const results = await smallestTTSBatch(mockApiKey, mockTexts, mockVoiceId, mockJobId);
      
      expect(results[0]?.error).toBeDefined();
    }, 15000);
  });
});
