import { useMemo } from 'preact/hooks';

let gradientSeq = 0;

/** Circular progress gauge with a soft gradient stroke. `value` is 0..1. */
export function Gauge({
  value,
  size = 168,
  stroke = 12,
  from,
  to,
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  from: string;
  to: string;
  children?: preact.ComponentChildren;
}) {
  const id = useMemo(() => `g${++gradientSeq}`, []);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div class="gauge" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color={from} />
            <stop offset="100%" stop-color={to} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" stroke-width={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${id})`}
          stroke-width={stroke}
          stroke-linecap="round"
          stroke-dasharray={`${c * v} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          class="gauge-arc"
        />
      </svg>
      <div class="gauge-center">{children}</div>
    </div>
  );
}

interface Point {
  x: number;
  y: number;
}

/** Catmull-Rom → cubic Bézier for a smooth line through the points. */
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const t = 0.18;
    const c1 = [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2 = [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * Smooth area chart with a gradient fill, a dashed average line and an emphasized
 * last point. `xLabels` are drawn under the chart at their x positions.
 */
export function AreaChart({
  points,
  color,
  height = 140,
  showAverage = true,
  xLabels = [],
  emptyText = 'Not enough data yet.',
}: {
  points: Point[];
  color: string;
  height?: number;
  showAverage?: boolean;
  xLabels?: { x: number; label: string }[];
  emptyText?: string;
}) {
  const id = useMemo(() => `a${++gradientSeq}`, []);
  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const W = 320;
    const padTop = 14;
    const padBottom = 6;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    const span = y1 - y0 || Math.abs(y1) * 0.1 || 1;
    const lo = y0 - span * 0.25;
    const hi = y1 + span * 0.15;
    const px = (x: number) => ((x - x0) / (x1 - x0 || 1)) * W;
    const py = (y: number) => padTop + (1 - (y - lo) / (hi - lo)) * (height - padTop - padBottom);
    const pts = points.map((p) => [px(p.x), py(p.y)] as [number, number]);
    const line = smoothPath(pts);
    const area = `${line} L${W},${height} L0,${height} Z`;
    const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
    return { W, line, area, last: pts[pts.length - 1], avgY: py(avg), px, x0, x1 };
  }, [points, height]);

  if (!geo) return <p class="muted small chart-empty">{emptyText}</p>;
  return (
    <div class="area-chart">
      <svg viewBox={`0 0 ${geo.W} ${height}`} preserveAspectRatio="none" style={{ height }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color={color} stop-opacity="0.35" />
            <stop offset="100%" stop-color={color} stop-opacity="0" />
          </linearGradient>
        </defs>
        <path d={geo.area} fill={`url(#${id})`} />
        {showAverage && (
          <line x1="0" x2={geo.W} y1={geo.avgY} y2={geo.avgY} stroke="rgba(255,255,255,0.28)" stroke-dasharray="3 5" vector-effect="non-scaling-stroke" />
        )}
        <path d={geo.line} fill="none" stroke={color} stroke-width="2.2" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      </svg>
      <span class="chart-dot" style={{ left: `${(geo.last[0] / geo.W) * 100}%`, top: `${geo.last[1]}px`, background: color, boxShadow: `0 0 0 4px color-mix(in srgb, ${color} 25%, transparent)` }} />
      {xLabels.length > 0 && (
        <div class="chart-x">
          {xLabels
            .filter((l) => l.x >= geo.x0 && l.x <= geo.x1)
            .map((l) => (
              <span key={l.label} style={{ left: `${(geo.px(l.x) / geo.W) * 100}%` }}>
                {l.label}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

/** Thin horizontal bar positioning `value` within the user's own [min, max] range. */
export function RangeBar({ value, min, max, color }: { value?: number; min?: number; max?: number; color: string }) {
  if (value === undefined || min === undefined || max === undefined) return <div class="range-bar" />;
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 50;
  return (
    <div class="range-bar">
      <span style={{ left: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}
