import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PlayerSeekGroup } from "@/components/player-seek-group";
import { FINE_SEEK_ALWAYS_SECONDS } from "@/lib/player/seek";

/**
 * Mirrors the book player's wiring for the seek group: the page owns fine
 * visibility (long audio lifts it on load, a scrub lifts it otherwise, and
 * nothing drops it) and freezes playhead ticks while a drag is held.
 * "Playback" ticks five seconds per 100ms so a two-minute window slides
 * within a few real seconds.
 */
function Harness() {
  const params = new URLSearchParams(window.location.search);
  const duration = Number(params.get("d") || 3600);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fineTouched, setFineTouched] = useState(false);
  const [commits, setCommits] = useState<number[]>([]);
  const fineVisible = fineTouched || duration >= FINE_SEEK_ALWAYS_SECONDS;

  useEffect(() => {
    if (!playing || dragging) return;
    const id = setInterval(() => {
      setCurrentTime((t) => Math.min(duration, t + 5));
    }, 100);
    return () => clearInterval(id);
  }, [playing, dragging, duration]);

  return (
    <div style={{ margin: "0 auto", maxWidth: "42rem", padding: "16px", boxSizing: "border-box" }}>
      <button
        data-testid="toggle"
        type="button"
        onClick={() => setPlaying((p) => !p)}
      >
        {playing ? "Pause" : "Play"}
      </button>
      <button data-testid="elsewhere" type="button" onClick={() => {}}>
        Elsewhere
      </button>
      <p data-testid="clock">{Math.round(currentTime)}</p>
      <p data-testid="commits">{commits.join(",")}</p>
      <PlayerSeekGroup
        currentTime={currentTime}
        duration={duration}
        fineVisible={fineVisible}
        onFineReveal={() => setFineTouched(true)}
        onScrub={setCurrentTime}
        onScrubCommit={(seconds) => {
          setCurrentTime(seconds);
          setCommits((prev) => [...prev, Math.round(seconds)]);
        }}
        onScrubActiveChange={setDragging}
      />
      <div
        data-testid="below"
        style={{ marginTop: "2rem", height: "4rem", border: "1px solid #555" }}
      >
        Below
      </div>
    </div>
  );
}

const stage = document.getElementById("stage");
if (stage) createRoot(stage).render(<Harness />);