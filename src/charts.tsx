import { useMemo } from 'preact/hooks';

interface Point {
  x: number;
  y: number;
}

/** Minimal dependency-free SVG line chart. */
export function LineChart({ points, height = 120, color = 'var(--accent)', unit = '' }: { points: Point[]; height?: number; color?: string; unit?: string }) {
  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    const pad = (y1 - y0) * 0.1 || 1;
    const lo = y0 - pad;
    const hi = y1 + pad;
    const w = 300;
    const px = (x: number) => ((x - x0) / (x1 - x0 || 1)) * w;
    const py = (y: number) => height - ((y - lo) / (hi - lo)) * height;
    return { d: points.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(''), y0, y1, w };
  }, [points, height]);
  if (!geo) return <p class="muted small">Not enough data yet.</p>;
  return (
    <div class="chart">
      <svg viewBox={`0 0 ${geo.w} ${height}`} preserveAspectRatio="none" style={{ height }}>
        <path d={geo.d} fill="none" stroke={color} stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      </svg>
      <div class="chart-scale small muted">
        <span>
          {Math.round(geo.y1)}
          {unit}
        </span>
        <span>
          {Math.round(geo.y0)}
          {unit}
        </span>
      </div>
    </div>
  );
}

/** One bar per labelled value (nightly trends). */
export function Bars({ items, color = 'var(--accent)', unit = '', digits = 0 }: { items: { label: string; value?: number }[]; color?: string; unit?: string; digits?: number }) {
  const vals = items.map((i) => i.value).filter((v): v is number => v !== undefined);
  if (!vals.length) return <p class="muted small">No data yet.</p>;
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const floor = min - (max - min || max) * 0.5;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const latest = [...items].reverse().find((i) => i.value !== undefined)?.value;
  return (
    <>
    <p class="small muted">
      Latest <strong class="text">{latest?.toFixed(digits)}{unit}</strong> · {vals.length}-night average {avg.toFixed(digits)}
      {unit}
    </p>
    <div class="bars">
      {items.map((i) => (
        <div class="bar" key={i.label} title={`${i.label}: ${i.value?.toFixed(digits) ?? '–'}${unit}`}>
          <div class="bar-fill" style={{ height: i.value === undefined ? '0%' : `${Math.max(4, ((i.value - floor) / (max - floor || 1)) * 100)}%`, background: color }} />
          <span class="bar-label">{i.label.slice(8)}</span>
        </div>
      ))}
    </div>
    </>
  );
}
