import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

let ffmpeg: FFmpeg | null = null;

export async function initializeFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg) {
    return ffmpeg;
  }

  ffmpeg = new FFmpeg();
  
  // Load FFmpeg.wasm
  await ffmpeg.load({
    coreURL: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js',
  });

  return ffmpeg;
}

export async function clipAudioFromYouTube(
  videoUrl: string,
  startTime: number,
  endTime: number
): Promise<Blob> {
  const ffmpegInstance = await initializeFFmpeg();
  
  try {
    // Note: In a real implementation, you would need to download the video first
    // This is a simplified version - actual implementation would require:
    // 1. Download video using youtube-dl or similar (server-side)
    // 2. Load video file into FFmpeg
    // 3. Clip audio segment
    // 4. Export as audio file
    
    // For client-side clipping, we'll need the audio file already downloaded
    // This function signature is for the interface, but actual implementation
    // would happen server-side or require pre-downloaded audio
    
    throw new Error('Client-side YouTube audio clipping requires pre-downloaded audio file');
  } catch (error) {
    console.error('Audio clipping error:', error);
    throw error;
  }
}

export async function clipAudioFromFile(
  audioFile: File,
  startTime: number,
  endTime: number
): Promise<Blob> {
  const ffmpegInstance = await initializeFFmpeg();
  
  try {
    const duration = endTime - startTime;
    
    // Write input file
    await ffmpegInstance.writeFile('input.mp3', await fetchFile(audioFile));
    
    // Clip audio
    await ffmpegInstance.exec([
      '-i', 'input.mp3',
      '-ss', startTime.toString(),
      '-t', duration.toString(),
      '-acodec', 'copy',
      'output.mp3'
    ]);
    
    // Read output
    const data = await ffmpegInstance.readFile('output.mp3');
    
    // Cleanup
    await ffmpegInstance.deleteFile('input.mp3');
    await ffmpegInstance.deleteFile('output.mp3');
    
    return new Blob([data], { type: 'audio/mpeg' });
  } catch (error) {
    console.error('Audio clipping error:', error);
    throw new Error('Failed to clip audio file');
  }
}

