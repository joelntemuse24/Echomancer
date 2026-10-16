import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReadAlongTranscript } from "../src/components/read-along-transcript";
import { buildReadAlongDocument } from "../src/lib/player/read-along";

const document = buildReadAlongDocument({
  frozenSections: Array.from({ length: 240 }, (_, index) => ({
    index, text: `Passage ${index}. The harbor was quiet.`, durationSeconds: 10,
  })),
});
function Harness() {
  const [time, setTime] = useState(0);
  const [seek, setSeek] = useState(-1);
  const [stream, setStream] = useState(false);
  return <>
    <button onClick={() => setTime(1800)}>Advance audio</button>
    <button onClick={() => setStream(true)}>Stream</button>
    <output data-testid="seek">{seek}</output>
    <ReadAlongTranscript document={document} onSeek={stream ? undefined : setSeek}
      position={{ mode: stream ? "stream" : "full", currentTime: time,
        duration: 2400, sectionIndex: null, streamCursor: document.charCount - 1 }} />
  </>;
}
createRoot(window.document.getElementById("root")!).render(<Harness />);
