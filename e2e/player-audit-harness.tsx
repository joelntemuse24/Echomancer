import { createRoot } from "react-dom/client";
import PlayerPage from "../src/app/dashboard/player/[id]/page";
import { PlaybackProvider } from "../src/components/playback-provider";

// The player page reads the one media element from the root-layout shell.
createRoot(document.getElementById("root")!).render(
  <PlaybackProvider>
    <PlayerPage />
  </PlaybackProvider>
);
