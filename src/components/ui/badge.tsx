import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#D97757] focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[#D97757] text-[#0d0d0d]",
        secondary: "border-transparent bg-[#242424] text-[#faf9f7]",
        destructive: "border-transparent bg-[#a65d4d]/20 text-[#a65d4d] border-[#a65d4d]/30",
        outline: "border-[#333] text-[#faf9f7]",
        // Editorial status variants
        sage: "border-transparent bg-[#7a8f7e]/20 text-[#7a8f7e] border-[#7a8f7e]/30",
        copper: "border-transparent bg-[#D97757]/20 text-[#D97757] border-[#D97757]/30",
        taupe: "border-transparent bg-[#a39b8f]/20 text-[#a39b8f] border-[#a39b8f]/30",
        brick: "border-transparent bg-[#a65d4d]/20 text-[#a65d4d] border-[#a65d4d]/30",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
