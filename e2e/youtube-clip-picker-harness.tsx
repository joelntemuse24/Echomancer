import { createRoot } from "react-dom/client";
import { YoutubeClipPicker } from "@/components/youtube-clip-picker";

// The harness server supplies layout utilities; network and iframe stay local.
let currentTime = 0;
let seeks = 0;
let plays = 0;
window.YT = {
  Player: class {
    constructor(host: HTMLElement, options: { events?: { onReady?: (event: { target: { seekTo: (seconds: number, allowSeekAhead: boolean) => void; playVideo: () => void; pauseVideo: () => void; getCurrentTime: () => number; getDuration: () => number; destroy: () => void } }) => void } }) {
      const frame = document.createElement("iframe");
      frame.title = "YouTube preview";
      frame.style.width = "100%";
      frame.style.height = "100%";
      host.replaceWith(frame);
      setTimeout(() => options.events?.onReady?.({ target: this }), 0);
    }
    seekTo(seconds: number) { currentTime = seconds; seeks++; update(); }
    playVideo() { plays++; update(); }
    pauseVideo() {}
    getCurrentTime() { return currentTime; }
    getDuration() { return 7200; }
    destroy() {}
  },
};

function update() {
  const stats = document.getElementById("picker-stats");
  if (stats) stats.textContent = `${seeks} seeks; ${plays} plays`;
}

const owner = new URLSearchParams(location.search).get("owner") || "owner-a";
let accepted = false;
window.fetch = async (input, init) => {
  const url = String(input);
  if (url === "/api/clips/clip-recovery") {
    if (init?.method === "POST") { accepted = true; return Response.json({ id: "clip-recovery", status: "queued" }); }
    return Response.json(accepted ? { status: "ready", ownerContext: owner, catalogVoiceId: "clone:clip-recovery", title: "Recovered speaker" } : {
      status: "failed", error: "risky_audio", ownerContext: owner, uploadId: "clip-recovery",
      title: "Recovered speaker", source: { videoId: "abcdefghijk", startSec: 45, endSec: 65 },
      risk: { headline: "This clip may not clone well.", body: "Try a cleaner clip.", issues: [{code: "echo", detail: "Room echo"}] },
    });
  }
  if (url === "/api/clips") return Response.json({ enabled: true, ownerContext: owner });
  if (url.startsWith("/api/tts/youtube/search")) return Response.json({ error: "Search unavailable" }, { status: 503 });
  return Response.json({ error: "Not found" }, { status: 404 });
};

const stage = document.getElementById("stage");
if (stage) createRoot(stage).render(
  <div style={{ maxWidth: 480, margin: "0 auto" }}>
    <YoutubeClipPicker onCloned={() => {}} onUploadInstead={() => {}} />
    <p id="picker-stats">0 seeks; 0 plays</p>
  </div>,
);
