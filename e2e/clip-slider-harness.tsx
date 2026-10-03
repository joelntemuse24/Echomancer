import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ClipRangeSlider } from "@/components/clip-range-slider";
import { clipRequestWindow } from "@/lib/youtube/clip-slider";
import { formatClock } from "@/lib/youtube/range";

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const duration = Number(params.get("d") || 7200);
  const [span, setSpan] = useState({
    startSec: Number(params.get("start") || 45),
    endSec: Number(params.get("end") || 65),
  });
  const request = clipRequestWindow(span.startSec, span.endSec, duration);
  const start = request?.startSeconds ?? span.startSec;
  const end = request ? request.startSeconds + request.lengthSeconds : span.endSec;
  return (
    <div>
      <p data-testid="label">
        Voice sample · {formatClock(start)}–{formatClock(end)} (40s max)
      </p>
      <p data-testid="request">{request ? `${request.startSeconds}+${request.lengthSeconds}` : "none"}</p>
      <ClipRangeSlider
        startSec={span.startSec}
        endSec={span.endSec}
        durationSec={duration}
        resetKey={String(duration)}
        onChange={setSpan}
      />
    </div>
  );
}

const stage = document.getElementById("stage");
if (stage) createRoot(stage).render(<Harness />);
