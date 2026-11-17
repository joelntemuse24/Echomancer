import { YOUTUBE_COPY } from "@/lib/youtube/messages";

/**
 * First sentence of the clone upload panel.
 * A chosen file is named here. The YouTube outage is not that sentence.
 */
export function cloneUploadLead(fileSelected: boolean): string {
  if (fileSelected) return "Name this voice. You can change it later.";
  return YOUTUBE_COPY.sampleGuide;
}

/**
 * The YouTube outage line. Hidden while a file is the clip being named,
 * and hidden when clips themselves are available. Sign-in is its own sentence.
 */
export function youtubeClipNotice(input: {
  fileSelected: boolean;
  clipsEnabled: boolean;
  needsSignIn?: boolean;
}): string | null {
  if (input.fileSelected || input.clipsEnabled) return null;
  if (input.needsSignIn) return YOUTUBE_COPY.clippingNeedsSignIn;
  return YOUTUBE_COPY.clippingUnavailable;
}
