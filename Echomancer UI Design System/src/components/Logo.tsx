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
    <div className="flex items-center gap-3">
      <div className={`${sizeClasses[size]} relative flex items-center justify-center`}>
        {/* Black circle background */}
        <div className="absolute inset-0 rounded-full bg-black border border-white/10" />
        
        {/* Soundwave pattern */}
        <svg 
          className="absolute inset-0 w-full h-full opacity-30" 
          viewBox="0 0 100 100"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Subtle soundwave bars that seem to unravel */}
          <rect x="20" y="40" width="2" height="20" fill="white" opacity="0.6" />
          <rect x="25" y="35" width="2" height="30" fill="white" opacity="0.5" />
          <rect x="30" y="30" width="2" height="40" fill="white" opacity="0.4" />
          <rect x="35" y="38" width="2" height="24" fill="white" opacity="0.3" />
          <rect x="40" y="42" width="2" height="16" fill="white" opacity="0.25" />
          <rect x="45" y="45" width="2" height="10" fill="white" opacity="0.2" />
          <rect x="50" y="46" width="2" height="8" fill="white" opacity="0.15" />
          <rect x="55" y="47" width="2" height="6" fill="white" opacity="0.1" />
          
          {/* Glowing mouth/portal in center */}
          <ellipse 
            cx="50" 
            cy="50" 
            rx="12" 
            ry="6" 
            fill="none" 
            stroke="#8b5cf6" 
            strokeWidth="1.5"
            opacity="0.8"
          />
          <ellipse 
            cx="50" 
            cy="50" 
            rx="8" 
            ry="4" 
            fill="#8b5cf6" 
            opacity="0.3"
          />
        </svg>
      </div>
      
      <span className={`${textSizeClasses[size]} tracking-tight`}>
        echo<span className="text-primary">mancer</span>
      </span>
    </div>
  );
}
