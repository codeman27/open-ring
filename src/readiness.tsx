import { useMemo, useState } from 'preact/hooks';
import type { ScoreResult, Tier } from './scores';
import { tier as tierOf } from './scores';
import { CrownIcon, type IconProps } from './icons';

let sceneSeq = 0;

/** Full-bleed landscape behind the readiness hero; mood follows the tier. */
function Scene({ tier }: { tier: Tier }) {
  const id = useMemo(() => `s${++sceneSeq}`, []);
  const u = (n: string) => `url(#${id}${n})`;
  return (
    <svg class="scene" viewBox="0 0 400 640" preserveAspectRatio="xMidYMin slice" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}top`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#000" stop-opacity="0.25" />
          <stop offset="0.25" stop-color="#000" stop-opacity="0" />
        </linearGradient>
        {tier === 'good' && (
          <>
            <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#0d4a75" />
              <stop offset="0.35" stop-color="#2a7fae" />
              <stop offset="0.6" stop-color="#8cc9df" />
            </linearGradient>
            <radialGradient id={`${id}sun`} cx="0.72" cy="0.42" r="0.45">
              <stop offset="0" stop-color="#fff6dc" stop-opacity="0.9" />
              <stop offset="0.25" stop-color="#e9f6ff" stop-opacity="0.35" />
              <stop offset="1" stop-color="#e9f6ff" stop-opacity="0" />
            </radialGradient>
            <linearGradient id={`${id}snow`} x1="0" y1="0" x2="1" y2="0.6">
              <stop offset="0" stop-color="#9fb8c9" />
              <stop offset="0.55" stop-color="#f4f8fb" />
              <stop offset="1" stop-color="#d5e3ec" />
            </linearGradient>
            <linearGradient id={`${id}rock`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#3d6a88" />
              <stop offset="1" stop-color="#1c3e55" />
            </linearGradient>
            <linearGradient id={`${id}mist`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#cfe9f2" stop-opacity="0" />
              <stop offset="0.5" stop-color="#cfe9f2" stop-opacity="0.45" />
              <stop offset="1" stop-color="#cfe9f2" stop-opacity="0" />
            </linearGradient>
          </>
        )}
        {tier === 'fair' && (
          <>
            <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#22325a" />
              <stop offset="0.32" stop-color="#6b5a7a" />
              <stop offset="0.52" stop-color="#d89068" />
              <stop offset="0.62" stop-color="#f4c27e" />
            </linearGradient>
            <radialGradient id={`${id}sun`} cx="0.35" cy="0.56" r="0.4">
              <stop offset="0" stop-color="#fff0c4" stop-opacity="1" />
              <stop offset="0.12" stop-color="#ffd890" stop-opacity="0.8" />
              <stop offset="0.4" stop-color="#ffb070" stop-opacity="0.25" />
              <stop offset="1" stop-color="#ffb070" stop-opacity="0" />
            </radialGradient>
            <linearGradient id={`${id}mist`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#ffd9a8" stop-opacity="0" />
              <stop offset="0.5" stop-color="#ffd9a8" stop-opacity="0.35" />
              <stop offset="1" stop-color="#ffd9a8" stop-opacity="0" />
            </linearGradient>
          </>
        )}
        {tier === 'low' && (
          <>
            <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#16060d" />
              <stop offset="0.3" stop-color="#4a1020" />
              <stop offset="0.52" stop-color="#9a2a35" />
              <stop offset="0.62" stop-color="#c8513f" />
            </linearGradient>
            <radialGradient id={`${id}sun`} cx="0.62" cy="0.5" r="0.35">
              <stop offset="0" stop-color="#ffb08a" stop-opacity="0.85" />
              <stop offset="0.18" stop-color="#ff7a5c" stop-opacity="0.55" />
              <stop offset="1" stop-color="#ff5a4a" stop-opacity="0" />
            </radialGradient>
            <linearGradient id={`${id}mist`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#ff8a7a" stop-opacity="0" />
              <stop offset="0.5" stop-color="#ff8a7a" stop-opacity="0.22" />
              <stop offset="1" stop-color="#ff8a7a" stop-opacity="0" />
            </linearGradient>
          </>
        )}
      </defs>

      <rect width="400" height="640" fill={u('sky')} />
      <rect width="400" height="640" fill={u('sun')} />

      {tier === 'good' && (
        <g>
          <path d="M0 330 L60 290 L110 305 L170 270 L230 296 L300 262 L360 290 L400 276 L400 400 L0 400Z" fill="#7aa9c2" opacity="0.55" />
          <path d="M40 400 L150 300 L190 262 L214 228 L232 244 L262 280 L300 300 L380 400Z" fill={u('rock')} />
          <path d="M190 262 L214 228 L232 244 L248 266 L236 262 L224 276 L214 258 L204 274 L196 266Z" fill={u('snow')} />
          <path d="M214 228 L232 244 L262 280 L300 300 L330 330 L290 316 L262 300 L240 282 L226 260Z" fill="#e6f0f6" opacity="0.75" />
          <path d="M150 300 L190 262 L196 266 L176 296 L160 312Z" fill="#c7d9e4" opacity="0.6" />
          <rect y="300" width="400" height="80" fill={u('mist')} />
          <path d="M0 380 C60 350 110 360 170 344 C230 330 290 350 400 332 L400 640 L0 640Z" fill="#1d5b62" />
          <path d="M0 420 C70 392 140 404 210 388 C280 372 340 392 400 380 L400 640 L0 640Z" fill="#143f45" />
          <path d="M0 470 C90 446 170 458 250 444 C320 432 360 446 400 440 L400 640 L0 640Z" fill="#0c2a30" />
        </g>
      )}

      {tier === 'fair' && (
        <g>
          <path d="M0 360 C70 336 130 346 200 330 C270 316 330 334 400 322 L400 640 L0 640Z" fill="#8a6070" opacity="0.7" />
          <rect y="330" width="400" height="70" fill={u('mist')} />
          <path d="M0 392 C80 362 150 378 230 360 C300 346 350 362 400 356 L400 640 L0 640Z" fill="#5a3f55" />
          <path d="M0 430 C60 410 130 420 190 406 C260 390 330 414 400 400 L400 640 L0 640Z" fill="#3c2a40" />
          <path d="M0 480 C100 456 180 470 260 454 C330 442 370 456 400 452 L400 640 L0 640Z" fill="#231a2b" />
          <g fill="#1a1422">
            <path d="M318 456 L326 418 L334 456Z" />
            <path d="M336 454 L342 428 L348 454Z" />
            <path d="M62 470 L70 436 L78 470Z" />
          </g>
        </g>
      )}

      {tier === 'low' && (
        <g>
          <path d="M0 140 C80 128 160 150 260 132 C330 120 370 134 400 128 L400 158 C340 166 270 152 190 168 C110 182 50 162 0 170Z" fill="#2a0912" opacity="0.55" />
          <path d="M0 220 C90 204 170 226 250 210 C320 198 370 214 400 206 L400 230 C330 240 260 226 180 242 C100 256 40 236 0 244Z" fill="#3a0d18" opacity="0.4" />
          <path d="M0 350 L50 318 L90 334 L140 292 L180 322 L230 300 L280 330 L330 296 L400 326 L400 640 L0 640Z" fill="#5a1520" opacity="0.8" />
          <rect y="320" width="400" height="70" fill={u('mist')} />
          <path d="M0 400 L40 372 L80 386 L120 352 L170 388 L220 366 L270 394 L320 360 L360 380 L400 366 L400 640 L0 640Z" fill="#330b14" />
          <path d="M0 460 C80 440 160 452 240 436 C310 424 360 440 400 432 L400 640 L0 640Z" fill="#1a060b" />
        </g>
      )}

      <rect width="400" height="640" fill={u('top')} />
    </svg>
  );
}

const ARC_FROM = 200;
const ARC_SPAN = 140;
const CX = 160;
const CY = 168;
const R = 140;
const polar = (deg: number, r = R) => [CX + r * Math.cos((deg * Math.PI) / 180), CY + r * Math.sin((deg * Math.PI) / 180)] as const;
const arcPath = (to: number) => {
  const [x0, y0] = polar(ARC_FROM);
  const [x1, y1] = polar(to);
  return `M${x0.toFixed(1)},${y0.toFixed(1)} A${R},${R} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
};

function Dial({ value }: { value?: number }) {
  const v = value === undefined ? 0 : Math.max(0, Math.min(100, value)) / 100;
  const end = ARC_FROM + ARC_SPAN * v;
  const [kx, ky] = polar(end);
  const [l0x, l0y] = polar(ARC_FROM - 4, R - 14);
  const [l1x, l1y] = polar(ARC_FROM + ARC_SPAN + 4, R - 14);
  return (
    <svg class="dial" viewBox="0 0 320 120" aria-hidden="true">
      <path d={arcPath(ARC_FROM + ARC_SPAN)} fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="1.5" />
      {[0.2, 0.4, 0.6, 0.8].map((t) => {
        const [x, y] = polar(ARC_FROM + ARC_SPAN * t, R + 14);
        return <circle key={t} cx={x} cy={y} r="2" fill="rgba(255,255,255,0.75)" />;
      })}
      {value !== undefined && (
        <>
          <path class="dial-arc" d={arcPath(end)} fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" />
          <circle cx={kx} cy={ky} r="5" fill="#fff" />
        </>
      )}
      <text x={l0x} y={l0y} class="dial-tick" text-anchor="middle">0</text>
      <text x={l1x} y={l1y} class="dial-tick" text-anchor="middle">100</text>
    </svg>
  );
}

const COPY: Record<Tier, { headlines: string[]; messages: string[] }> = {
  good: {
    headlines: ['Go get ’em', 'Ready to roll', 'Full steam ahead'],
    messages: [
      'Your body is well recovered. If there’s something challenging on your list, today could be the day to tackle it.',
      'Your signals are strong and steady. A great day to push a little harder or try something new.',
      'You’re rested and recharged. Make the most of it, and keep your evening routine on track to stay here.',
    ],
  },
  fair: {
    headlines: ['Steady does it', 'Find your pace', 'Keep it balanced'],
    messages: [
      'You’re fairly recovered. A moderate day suits you: mix effort with breaks and aim for an early night.',
      'Your body is doing okay, but not at its peak. Go with the flow and don’t overcommit.',
      'Some of your signals are a little off your norm. Light to moderate activity and good sleep will help you bounce back.',
    ],
  },
  low: {
    headlines: ['Take it easy', 'Rest and recharge', 'Listen to your body'],
    messages: [
      'Your body is showing signs of strain. Prioritize rest, stay hydrated, and keep any training light today.',
      'Recovery is running low. Slow down where you can and give yourself an early night.',
      'Today is a day for gentle movement and recovery. Pushing hard now could set you back.',
    ],
  },
};

const HINTS: Record<string, string> = {
  'Resting heart rate': 'Your resting heart rate is higher than usual.',
  'HRV balance': 'Your heart rate variability is below your norm.',
  'Body temperature': 'Your body temperature is off your baseline.',
  'Previous night': 'Last night’s sleep was on the short side.',
  'Sleep balance': 'You’ve been running a sleep debt this week.',
  'Previous day activity': 'Yesterday’s activity was outside your usual range.',
};

const pick = <T,>(xs: T[], seed: string) => xs[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % xs.length];

export interface ScoreBubble {
  label: string;
  value?: number | string;
  unit?: string;
  Icon: (p: IconProps) => preact.JSX.Element;
  crown?: boolean;
}

function Bubbles({ items }: { items: ScoreBubble[] }) {
  return (
    <div class="bubbles">
      {items.map(({ label, value, unit, Icon, crown }) => (
        <div key={label} class="bubble">
          <div class="bubble-disc">
            <span class={`bubble-icon ${crown ? 'crown' : ''}`}>{crown ? <CrownIcon size={13} /> : <Icon size={13} />}</span>
            <span class="bubble-value">
              {value ?? '–'}
              {unit && value !== undefined && <small>{unit}</small>}
            </span>
          </div>
          <span class="bubble-label">{label}</span>
        </div>
      ))}
    </div>
  );
}

/** Oura-style readiness hero: score bubbles, dial and a mood-matched scene. */
export function ReadinessHero({
  readiness,
  bubbles,
  seed,
}: {
  readiness?: ScoreResult;
  bubbles: ScoreBubble[];
  seed: string;
}) {
  const [open, setOpen] = useState(false);
  const t = readiness ? tierOf(readiness.score) : 'good';
  const copy = COPY[t];
  const weakest = readiness?.contributors.reduce((a, b) => (b.score < a.score ? b : a));
  const hint = weakest && weakest.score < 70 ? HINTS[weakest.label] : undefined;
  return (
    <section class={`card readiness tier-${t} ${readiness ? '' : 'pending'}`}>
      <Scene tier={t} />
      <div class="scene-shade" />
      <div class="readiness-body">
        <Bubbles items={bubbles} />
        <div class="dial-wrap">
          <Dial value={readiness?.score} />
          {readiness && readiness.score >= 85 && (
            <span class="dial-badge">
              <CrownIcon size={14} />
            </span>
          )}
        </div>
        <div class="readiness-score">{readiness?.score ?? '–'}</div>
        <div class="readiness-label">Readiness</div>
        {readiness ? (
          <>
            <h2 class="readiness-headline">{pick(copy.headlines, seed)}</h2>
            <p class="readiness-msg">
              {pick(copy.messages, seed)}
              {hint && ` ${hint}`}
            </p>
            <button class="readiness-more" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Hide contributors' : 'Contributors'}
            </button>
            {open && (
              <div class="contributors">
                {readiness.contributors.map((c) => (
                  <div key={c.label} class="contributor">
                    <div class="contributor-head">
                      <span>{c.label}</span>
                      <span>{c.score}</span>
                    </div>
                    <div class="contributor-bar">
                      <span style={{ width: `${c.score}%` }} class={`tier-${tierOf(c.score)}`} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {readiness.provisional && <p class="readiness-note">Estimated on-device. Gets more accurate after about 2 weeks of nights.</p>}
          </>
        ) : (
          <p class="readiness-msg">Wear your ring tonight and sync in the morning to see how ready you are.</p>
        )}
      </div>
    </section>
  );
}
