import { useId } from 'react';

export interface BeeMascotProps {
  size?: number;
  className?: string;
  ariaLabel?: string;
}

export function BeeMascot({ size = 28, className, ariaLabel }: BeeMascotProps) {
  const isAccessible = Boolean(ariaLabel);
  const instanceId = useId().replace(/:/g, '');
  const gradientId = `bee-body-gradient-${instanceId}`;
  const clipId = `bee-body-clip-${instanceId}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className ? `bee-mascot ${className}` : 'bee-mascot'}
      {...(isAccessible
        ? { role: 'img', 'aria-label': ariaLabel }
        : { 'aria-hidden': 'true' })}
    >
      {/* Back wing */}
      <ellipse
        cx="19.5"
        cy="9.5"
        rx="5.5"
        ry="7.5"
        transform="rotate(28 19.5 9.5)"
        fill="rgba(255, 255, 255, 0.82)"
        stroke="#cfc3b4"
        strokeWidth="1.2"
      />
      {/* Front wing */}
      <ellipse
        cx="14"
        cy="8.5"
        rx="5"
        ry="7"
        transform="rotate(-15 14 8.5)"
        fill="rgba(255, 255, 255, 0.92)"
        stroke="#c4b6a5"
        strokeWidth="1.2"
      />
      {/* Antennae */}
      <path
        d="M9 13.5C7.5 11 6.5 8.5 7.5 7"
        stroke="#2d211c"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="7.8" cy="6.5" r="1" fill="#2d211c" />
      <path
        d="M12.5 12C12 9.5 12.5 7.5 14 6"
        stroke="#2d211c"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="14.2" cy="5.5" r="1" fill="#2d211c" />

      {/* Tiny rounded stinger */}
      <path
        d="M24.5 21L27 21.8L24.8 23Z"
        fill="#2d211c"
        strokeLinejoin="round"
      />

      {/* Bee body */}
      <ellipse
        cx="16"
        cy="20"
        rx="10"
        ry="8.5"
        fill={`url(#${gradientId})`}
      />

      {/* Body stripes (clipped to body) */}
      <g clipPath={`url(#${clipId})`}>
        {/* Stripe 1 */}
        <rect x="13.5" y="10" width="3.2" height="20" fill="#2d211c" />
        {/* Stripe 2 */}
        <rect x="19" y="10" width="3.2" height="20" fill="#2d211c" />
      </g>

      {/* Face features (eyes & smile & blush) */}
      <circle cx="9.5" cy="18.5" r="1.3" fill="#2d211c" />
      <circle cx="10" cy="18.1" r="0.4" fill="#ffffff" />
      <path
        d="M7.8 21.2C8.5 22.2 9.8 22.2 10.5 21.2"
        stroke="#2d211c"
        strokeWidth="1"
        strokeLinecap="round"
      />
      {/* Soft blush */}
      <ellipse cx="11.8" cy="20.5" rx="1.2" ry="0.8" fill="#e89578" opacity="0.65" />

      <defs>
        <linearGradient id={gradientId} x1="6" y1="13" x2="26" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f3be4d" />
          <stop offset="1" stopColor="#c57f27" />
        </linearGradient>
        <clipPath id={clipId}>
          <ellipse cx="16" cy="20" rx="10" ry="8.5" />
        </clipPath>
      </defs>
    </svg>
  );
}
