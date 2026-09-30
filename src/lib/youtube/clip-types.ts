/**
 * Shared YouTube clip contract. No ffmpeg / yt-dlp imports — the Vercel
 * route and the worker client both use this file.
 */

import type { CloneAccent } from "@/lib/tts/clone-accent";

export type YoutubeClipRequest = {
  userId: string;
  videoId: string;
  startSec: number;
  endSec: number;
  title?: string;
  accent?: CloneAccent | string | null;
  consent: boolean;
};

export type YoutubeClipTimings = {
  fetchMs: number;
  masterMs: number;
  cloneMs: number;
  totalMs: number;
};

export type YoutubeClipSuccess = {
  ok: true;
  strategy: string;
  timings: YoutubeClipTimings;
  clone: {
    catalogVoiceId: string;
    displayName: string;
    state?: string;
    createdAt?: number;
  };
};

export type YoutubeClipFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  fallback: "upload";
};

export type YoutubeClipResult = YoutubeClipSuccess | YoutubeClipFailure;
