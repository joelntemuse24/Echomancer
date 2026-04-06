import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-md border border-[#333] bg-[#1a1a1a] px-3 py-1 text-base transition-all duration-200 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-[#faf9f7] placeholder:text-[#a39b8f] focus-visible:outline-none focus-visible:border-[#D97757] focus-visible:ring-1 focus-visible:ring-[#D97757]/20 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
