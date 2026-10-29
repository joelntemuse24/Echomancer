import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PlayerSeekGroup } from "@/components/player-seek-group";
import { usePreciseSeek } from "@/hooks/use-precise-seek";

/**
 * Mirrors the book player's wiring for the seek group: the precise
 * scrubber is a disclosure the listener opens, and a held drag freezes the
 * playhead ticks. "Playback" ticks five seconds per 100ms so a two-minute
 * window slides within a few real seconds.
 */
function Harness() {
  const params = new URLSearchParams(window.location.search);
  const duration = Number(params.get("d") || 3600);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  // The same remembered disclosure the book player uses.
  const { preciseSeek: precise, setPreciseSeek: setPrecise } = usePreciseSeek();
  const [commits, setCommits] = useState<number[]>([]);

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
        fineVisible={precise}
        onFineVisibleChange={setPrecise}
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
