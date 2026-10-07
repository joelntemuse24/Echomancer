"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  activeBlockIndex,
  sentenceStartInText,
  type ReadAlongDocument,
  type ReadAlongPosition,
  type TranscriptBlock,
} from "@/lib/player/read-along";
import { cn } from "@/lib/utils";

function offsetInElement(el: HTMLElement, x: number, y: number): number | null {
  const doc = el.ownerDocument;
  const fromRange = doc.caretRangeFromPoint?.(x, y);
  if (fromRange && el.contains(fromRange.startContainer)) {
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.setEnd(fromRange.startContainer, fromRange.startOffset);
    return range.toString().length;
  }
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos && el.contains(pos.offsetNode)) {
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.setEnd(pos.offsetNode, pos.offset);
    return range.toString().length;
  }
  return null;
}

const BlockRow = memo(function BlockRow({
  block,
  index,
  isActive,
  onSeek,
}: {
  block: TranscriptBlock;
  index: number;
  isActive: boolean;
  onSeek: (charStart: number, localOffset: number | null) => void;
}) {
  const seekHere = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      const local = offsetInElement(event.currentTarget, event.clientX, event.clientY);
      onSeek(block.charStart, local);
    },
    [block.charStart, onSeek]
  );
  if (block.kind === "chapter") {
    return (
      <h2
        data-block={index}
        onDoubleClick={seekHere}
        className={cn(
          "font-serif tracking-tight text-foreground",
          block.level === 1 ? "pt-6 text-3xl" : "pt-4 text-xl",
          index === 0 && "pt-0",
          isActive ? "opacity-100" : "opacity-70"
        )}
        style={{ fontWeight: 400 }}
      >
        {block.text}
      </h2>
    );
  }
  return (
    <p
      data-block={index}
      onDoubleClick={seekHere}
      className={cn(
        "font-serif text-[1.2rem] leading-8",
        isActive ? "text-foreground" : "text-muted-foreground/80"
      )}
    >
      {block.text}
    </p>
  );
});

function isOutsideViewport(root: HTMLElement, node: HTMLElement): boolean {
  const view = root.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  return rect.top < view.top || rect.bottom > view.bottom;
}

export function ReadAlongTranscript({
  document,
  position,
  onSeek,
}: {
  document: ReadAlongDocument;
  position: ReadAlongPosition;
  /** Double-tap a passage. No extra chrome. */
  onSeek?: (charIndex: number) => void;
}) {
  const active = useMemo(
    () => activeBlockIndex(document, position),
    // Position is rebuilt every tick; depend on its fields, not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      document,
      position.mode,
      position.currentTime,
      position.duration,
      position.sectionIndex,
      position.streamCursor,
    ]
  );
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [following, setFollowing] = useState(true);
  const pauseUntilRef = useRef(0);
  // seekToChar is rebuilt every player render; the ref keeps row props stable
  // so memoized rows skip the 4 Hz timeupdate renders.
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  const scrollToActive = useCallback(() => {
    const root = scrollerRef.current;
    const node = root?.querySelector<HTMLElement>(`[data-block="${activeRef.current}"]`);
    if (root && node && isOutsideViewport(root, node)) {
      node.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, []);

  useEffect(() => {
    if (!following) return;
    if (Date.now() < pauseUntilRef.current) return;
    scrollToActive();
  }, [active, following, scrollToActive]);

  const handleSeek = useCallback(
    (charStart: number, local: number | null) => {
      const seek = onSeekRef.current;
      if (!seek) return;
      const block = document.blocks.find((item) => item.charStart === charStart);
      const into = block && local != null ? sentenceStartInText(block.text, local) : 0;
      seek(charStart + into);
      setFollowing(true);
      pauseUntilRef.current = 0;
    },
    [document.blocks]
  );

  if (document.blocks.length === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        Transcript isn’t ready.
      </p>
    );
  }

  return (
    <div
      ref={scrollerRef}
      onScroll={() => {
        pauseUntilRef.current = Date.now() + 2500;
      }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        setFollowing(false);
      }}
      className="mx-auto max-h-[min(70vh,40rem)] max-w-[38rem] touch-manipulation select-none overflow-y-auto px-2 py-2"
    >
      <div className="space-y-5 pb-8">
        {document.blocks.map((block, index) => (
          <BlockRow
            key={block.id}
            block={block}
            index={index}
            isActive={index === active}
            onSeek={handleSeek}
          />
        ))}
      </div>
      {!following ? (
        <div className="sticky bottom-2 flex justify-center">
          <button
            type="button"
            onClick={() => {
              setFollowing(true);
              pauseUntilRef.current = 0;
              scrollToActive();
            }}
            className="text-xs text-muted-foreground/70 hover:text-foreground"
          >
            Follow along
          </button>
        </div>
      ) : null}
    </div>
  );
}
