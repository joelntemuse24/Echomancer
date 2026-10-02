"use client";

import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/lib/utils";

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  line = false,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** Hairline seek bar. The thumb stays for keyboard and pointer, unseen. */
  line?: boolean;
}) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max],
  );

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full touch-none items-center select-none min-h-11 py-3 data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          "relative grow overflow-hidden bg-foreground/20 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            "absolute bg-foreground data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full",
          )}
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          className={
            line
              ? "relative block size-4 shrink-0 rounded-full border-0 bg-transparent opacity-0 before:absolute before:inset-[-14px] before:content-[''] focus-visible:outline-hidden"
              : "relative block size-3 shrink-0 rounded-full border border-foreground bg-background before:absolute before:inset-[-12px] before:content-[''] focus-visible:outline-hidden"
          }
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
