"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  activeBlockIndex,
  sentenceStartInText,
  type ReadAlongDocument,
  type ReadAlongPosition,
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
  const active = activeBlockIndex(document, position);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const pauseUntilRef = useRef(0);

  useEffect(() => {
    if (!following) return;
    if (Date.now() < pauseUntilRef.current) return;
    const root = scrollerRef.current;
    const node = root?.querySelector<HTMLElement>(`[data-block="${active}"]`);
    node?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active, following]);

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
        {document.blocks.map((block, index) => {
          const isActive = index === active;
          const seekHere = (event: MouseEvent<HTMLElement>) => {
            if (!onSeek) return;
            event.preventDefault();
            const local = offsetInElement(event.currentTarget, event.clientX, event.clientY);
            const into =
              local == null ? 0 : sentenceStartInText(block.text, local);
            onSeek(block.charStart + into);
            setFollowing(true);
            pauseUntilRef.current = 0;
          };
          if (block.kind === "chapter") {
            return (
              <h2
                key={block.id}
                data-block={index}
                onDoubleClick={seekHere}
                className={cn(
                  "font-serif tracking-tight text-foreground",
                  block.level === 1
                    ? "pt-6 text-3xl"
                    : "pt-4 text-xl",
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
              key={block.id}
              data-block={index}
              onDoubleClick={seekHere}
              className={cn(
                "font-serif text-[1.2rem] leading-8",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground/80"
              )}
            >
              {block.text}
            </p>
          );
        })}
      </div>
      {!following ? (
        <div className="sticky bottom-2 flex justify-center">
          <button
            type="button"
            onClick={() => {
              setFollowing(true);
              pauseUntilRef.current = 0;
              const root = scrollerRef.current;
              const node = root?.querySelector<HTMLElement>(
                `[data-block="${active}"]`
              );
              node?.scrollIntoView({ block: "center", behavior: "smooth" });
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
