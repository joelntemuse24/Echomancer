import Link from "next/link";

export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const textSizeClasses = {
    sm: "text-base",
    md: "text-lg",
    lg: "text-xl"
  };

  return (
    <Link href="/" className="flex items-center gap-2 cursor-pointer hover:opacity-70 transition-opacity">
      <span className={`${textSizeClasses[size]} tracking-tight font-medium text-[#faf9f7]`}>
        echo<span className="text-[#D97757]">mancer</span>
      </span>
    </Link>
  );
}
