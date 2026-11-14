/** Original line icons (24×24, stroke = currentColor). */
import type { ComponentChildren } from 'preact';

export interface IconProps {
  size?: number;
  class?: string;
}

function Svg({ size = 22, class: cls, children }: IconProps & { children: ComponentChildren }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      class={cls}
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const TodayIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Svg>
);

export const TrendsIcon = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="3 17 9 11 13 15 20 8" />
    <polyline points="15 8 20 8 20 13" />
  </Svg>
);

export const RingIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="5" />
  </Svg>
);

export const SyncIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5" />
    <polyline points="4 4 4 8.5 8.5 8.5" />
    <path d="M4 13a8 8 0 0 0 14.3 4.3L20 15.5" />
    <polyline points="20 20 20 15.5 15.5 15.5" />
  </Svg>
);

export const HeartIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z" />
  </Svg>
);

export const MoonIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" />
  </Svg>
);

export const DropIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5s-6 6.6-6 10.7a6 6 0 0 0 12 0C18 10.1 12 3.5 12 3.5z" />
  </Svg>
);

export const ThermometerIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 14.2V5a2 2 0 0 1 4 0v9.2a4 4 0 1 1-4 0z" />
    <line x1="12" y1="9" x2="12" y2="16" />
  </Svg>
);

export const LungsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v8" />
    <path d="M12 11c-1 1-2.5 1.5-3.5 1.5" />
    <path d="M12 11c1 1 2.5 1.5 3.5 1.5" />
    <path d="M8.5 7.5C6 8 4 11.5 4 16c0 2 1.2 3 2.7 3 2 0 2.8-1.6 2.8-4V8.4" />
    <path d="M15.5 7.5C18 8 20 11.5 20 16c0 2-1.2 3-2.7 3-2 0-2.8-1.6-2.8-4V8.4" />
  </Svg>
);

export const WaveIcon = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="2 12 7 12 9 6 13 18 15 12 22 12" />
  </Svg>
);

export const BoltIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 2.5 5 13.5h6l-1 8 8-11h-6l1-8z" />
  </Svg>
);

export const ChevronIcon = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="9 6 15 12 9 18" />
  </Svg>
);

export const BluetoothIcon = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="7 7 17 17 12 22 12 2 17 7 7 17" />
  </Svg>
);

export const KeyIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="12" r="4" />
    <path d="M12 12h9M18 12v3M21 12v2.5" />
  </Svg>
);

export const ExerciseIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="14" cy="4.5" r="1.8" />
    <path d="m7 21 3.5-6 3 2.5V22M10.5 15 12 9l-3.5 1.5L6.5 13M12 9l2.5 3 3.5 1" />
  </Svg>
);

export const CrownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 18h16M5 15 3.5 7l5 4L12 5l3.5 6 5-4L19 15Z" fill="currentColor" />
  </Svg>
);

export const BatteryIcon = ({ level = 0, ...p }: IconProps & { level?: number }) => {
  const w = (14 * Math.max(0, Math.min(100, level))) / 100;
  return (
    <Svg {...p}>
      <rect x="2" y="7" width="18" height="10" rx="2.5" />
      <path d="M22 10.5v3" />
      <rect x="4" y="9" width={w} height="6" rx="1" fill="currentColor" stroke="none" />
    </Svg>
  );
};
