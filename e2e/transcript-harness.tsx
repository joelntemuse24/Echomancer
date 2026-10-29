import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReadAlongTranscript } from "../src/components/read-along-transcript";
import { ReadAlongFocus } from "../src/components/read-along-focus";
import { useReadAlongFocus } from "../src/hooks/use-read-along-focus";
import { buildReadAlongDocument, passageSeekForChar } from "../src/lib/player/read-along";

const DURATION = 2400;
const document = buildReadAlongDocument({
  frozenSections: Array.from({ length: 240 }, (_, index) => ({
    index, text: `Passage ${index}. The harbor was quiet.`, durationSeconds: 10,
  })),
});

function Harness() {
  const [time, setTime] = useState(0);
  const [seek, setSeek] = useState(-1);
  const [stream, setStream] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1.15);
  // The same remembered preference the player page uses.
  const { focus, setFocus } = useReadAlongFocus();
  // Same clock the player uses, so a tap lands on the words under the finger.
  const seekToChar = (char: number) => {
    const at = passageSeekForChar(document, char);
    setSeek(char);
    setTime(at.fullSeconds ?? at.fraction * DURATION);
  };
  const position = {
    mode: (stream ? "stream" : "full") as "stream" | "full",
    currentTime: time,
    duration: DURATION,
    sectionIndex: null,
    streamCursor: null,
  };
  return <>
    <button onClick={() => setTime(1800)}>Advance audio</button>
    <button onClick={() => setTime((value) => value + 60)}>Next minute</button>
    <button onClick={() => setStream(true)}>Stream</button>
    <output data-testid="seek">{seek}</output>
    <output data-testid="speed">{speed}</output>
    {focus ? (
      <ReadAlongFocus
        document={document}
        position={position}
        onSeek={stream ? undefined : seekToChar}
        bookTitle="Audit book"
        chapterTitle="Chapter One"
        playing={playing}
        speed={speed}
        currentTime={time}
        duration={DURATION}
        streamMode={stream}
        onToggle={() => setPlaying((value) => !value)}
        onClose={() => setFocus(false)}
        onSkip={(delta) => setTime((value) => Math.max(0, value + delta))}
        onScrub={(seconds) => setTime(seconds)}
        onScrubCommit={(seconds) => setTime(seconds)}
        onScrubActiveChange={() => {}}
        onSpeedChange={setSpeed}
      />
    ) : (
      <ReadAlongTranscript document={document} onSeek={stream ? undefined : seekToChar}
        onToggleFullscreen={() => setFocus(true)}
        position={position} />
    )}
  </>;
}
createRoot(window.document.getElementById("root")!).render(<Harness />);
