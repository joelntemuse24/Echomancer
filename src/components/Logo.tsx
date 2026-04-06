import Link from "next/link";

export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizeClasses = {
    sm: "w-8 h-8",
    md: "w-10 h-10",
    lg: "w-12 h-12"
  };

  const textSizeClasses = {
    sm: "text-lg",
    md: "text-xl",
    lg: "text-2xl"
  };

  return (
    <Link href="/" className="flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity">
      <div className={`${sizeClasses[size]} relative flex items-center justify-center`}>
        <div className="absolute inset-0 rounded-full bg-[#1a1a1a] border border-[#333]" />
        <svg 
          className="absolute inset-0 w-full h-full opacity-40" 
          viewBox="0 0 100 100"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect x="20" y="40" width="2" height="20" fill="#D97757" opacity="0.8" />
          <rect x="25" y="35" width="2" height="30" fill="#D97757" opacity="0.7" />
          <rect x="30" y="30" width="2" height="40" fill="#D97757" opacity="0.6" />
          <rect x="35" y="38" width="2" height="24" fill="#D97757" opacity="0.5" />
          <rect x="40" y="42" width="2" height="16" fill="#D97757" opacity="0.4" />
          <rect x="45" y="45" width="2" height="10" fill="#D97757" opacity="0.3" />
          <rect x="50" y="46" width="2" height="8" fill="#D97757" opacity="0.25" />
          <rect x="55" y="47" width="2" height="6" fill="#D97757" opacity="0.2" />
          <ellipse cx="50" cy="50" rx="12" ry="6" fill="none" stroke="#D97757" strokeWidth="1.5" opacity="0.9" />
          <ellipse cx="50" cy="50" rx="8" ry="4" fill="#D97757" opacity="0.4" />
        </svg>
      </div>
      <span className={`${textSizeClasses[size]} tracking-tight font-[family-name:var(--font-source-serif)] text-[#faf9f7]`}>
        echo<span className="text-[#D97757]">mancer</span>
      </span>
    </Link>
  );
}
