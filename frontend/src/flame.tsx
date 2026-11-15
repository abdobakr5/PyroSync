import { useEffect, useId, useState } from "react";
import type { FlameTier } from "./earth";

/* Each layer morphs between path variants with identical command structure (SMIL), so the
   silhouette flows instead of merely scaling. Layer timings differ to avoid synchronization. */
const OUTER = [
  "M32 88C16 88 7 76 8.5 62C10 49 19 43 21 30C24 38 27 42 29.5 44C29 30 35 16 44 3C43 18 51 28 55 41C59 54 58 70 51 79C46 85 39 88 32 88Z",
  "M32 88C15 88 7 75 9 61C11 48 20 41 23 27C26 36 28.5 40 31 42C31.5 27 39 13 49 0C46 16 53 27 56 40C59.5 53 58 70 51 79C46 85 39 88 32 88Z",
  "M32 88C16 88 6 76 7.5 63C9 51 17 45 18 33C21.5 40 25 44 28 46C27 33 31 20 38 7C39 21 49 31 54 43C58.5 55 58 70 51 79C46 85 39 88 32 88Z",
  "M32 88C15.5 88 7.5 75.5 8.5 61.5C9.5 48.5 18.5 42 20 28C23 37 26.5 41.5 29.5 43C30 28.5 37 14 46.5 1.5C44.5 17 52 27.5 55.5 40.5C59 53.5 58 70 51 79C46 85 39 88 32 88Z",
];
const MIDDLE = [
  "M32 87C21 87 14 78 15 67C16 57 23 52 25 42C27.5 48 29.5 51 31.5 53C32 42 36.5 31 42 21C42 33 48 42 49.5 54C51.5 67 47 80 41 84.5C38 86.5 35 87 32 87Z",
  "M32 87C21 87 14.5 77 16 66C17.5 56 24.5 50 27 39C29 46 31 49 33 51C34 39 39 28 46 17C44.5 31 50 41 51 53C52.5 67 47 80 41 84.5C38 86.5 35 87 32 87Z",
  "M32 87C21 87 13.5 78 14.5 68C15.5 58 21.5 54 23 45C25.5 50 28 53 30 55C29.5 45 32.5 34 37 25C38.5 36 46.5 44 48.5 56C50.5 68 47 80 41 84.5C38 86.5 35 87 32 87Z",
];
const INNER = [
  "M32 86C25 86 21 80 21.5 73C22 66 27 62 28.5 55C30 59.5 31.5 61.5 33 63C33.5 56 36.5 49 40 44C40 52 43.5 58 44 66C44.5 76 40 86 32 86Z",
  "M32 86C25 86 21.5 79.5 22.5 72.5C23.5 65.5 28.5 61 30.5 53C32 58 33.5 60.5 35 62C36 54 39.5 47 43.5 41C42.5 50 45 57 45 65.5C45 76 40 86 32 86Z",
  "M32 86C25 86 20.5 80 21 73.5C21.5 67 25.5 63.5 26.5 57C28.5 61 30 63 31.5 64.5C31 58 33 51.5 35.5 46C37 53 42.5 59 43 67C43.5 76 40 86 32 86Z",
];
const loop = (frames: string[]) => [...frames, frames[0]].join(";");
const splines = (n: number) => Array.from({ length: n }, () => "0.45 0 0.55 1").join(";");
const times = (n: number) => Array.from({ length: n + 1 }, (_, i) => (i / n).toFixed(3)).join(";");

const EMBERS = [
  { x: 27, d: 1.6, drift: -5, r: 1.3, begin: 0 },
  { x: 37, d: 2.3, drift: 6, r: 1, begin: 0.5 },
  { x: 32, d: 1.9, drift: -2, r: 1.5, begin: 1.1 },
  { x: 41, d: 2.6, drift: 4, r: 0.9, begin: 0.2 },
  { x: 23, d: 2.1, drift: -6, r: 1.1, begin: 1.4 },
  { x: 35, d: 1.4, drift: 3, r: 0.8, begin: 0.8 },
  { x: 29, d: 2.8, drift: 5, r: 1.2, begin: 1.9 },
];
const EMBER_COUNT: Record<FlameTier, number> = { low: 2, moderate: 4, high: 7 };

export function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/**
 * Signature PYROSYNC thermal flame, shared by the landing scene, the globe selection, and data views.
 * Gradient runs Deep Blue → Electric Cyan → Warm Orange → Bright Orange → Flame Red.
 */
export function Flame({
  size = 40,
  animated = true,
  particles = false,
  intensity = "moderate",
  className = "",
  label,
}: {
  size?: number;
  animated?: boolean;
  particles?: boolean;
  intensity?: FlameTier;
  className?: string;
  label?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const reduced = useReducedMotion();
  const live = animated && !reduced;
  const morph = (frames: string[], dur: number, begin: number) =>
    live ? (
      <animate
        attributeName="d"
        dur={`${dur}s`}
        begin={`-${begin}s`}
        repeatCount="indefinite"
        values={loop(frames)}
        keyTimes={times(frames.length)}
        calcMode="spline"
        keySplines={splines(frames.length)}
      />
    ) : null;
  const embers = particles ? EMBERS.slice(0, EMBER_COUNT[intensity]) : [];
  return (
    <span
      className={`flame flame-${intensity} ${live ? "flame-animated" : ""} ${className}`}
      style={{ width: size, height: size * 1.4 }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 64 90" width="100%" height="100%" overflow="visible">
        <defs>
          <linearGradient id={`${id}o`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#075B91" />
            <stop offset=".13" stopColor="#20BCE5" />
            <stop offset=".34" stopColor="#FF963D" />
            <stop offset=".6" stopColor="#FF693B" />
            <stop offset=".86" stopColor="#F04438" />
            <stop offset="1" stopColor="#C62828" stopOpacity=".55" />
          </linearGradient>
          <linearGradient id={`${id}m`} x1="0" y1="1" x2="0" y2="0" spreadMethod="reflect">
            <stop offset="0" stopColor="#20BCE5" />
            <stop offset=".22" stopColor="#FFC15A" />
            <stop offset=".55" stopColor="#FF963D" />
            <stop offset="1" stopColor="#FF693B" />
            {live && (
              <animateTransform
                attributeName="gradientTransform"
                type="translate"
                values="0 0;0 -0.08;0 0"
                dur="1.3s"
                repeatCount="indefinite"
              />
            )}
          </linearGradient>
          <linearGradient id={`${id}i`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#B7F0FA" />
            <stop offset=".35" stopColor="#FFF4DA" />
            <stop offset=".7" stopColor="#FFE0A3" />
            <stop offset="1" stopColor="#FFC15A" />
          </linearGradient>
          <radialGradient id={`${id}c`} cx=".5" cy=".55" r=".5">
            <stop offset="0" stopColor="#FFFFFF" />
            <stop offset=".5" stopColor="#E9FBFF" stopOpacity=".9" />
            <stop offset="1" stopColor="#8BE7F5" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}h`}>
            <stop offset="0" stopColor="#FF963D" stopOpacity=".5" />
            <stop offset=".5" stopColor="#FF693B" stopOpacity=".18" />
            <stop offset="1" stopColor="#F04438" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}b`}>
            <stop offset="0" stopColor="#8BE7F5" stopOpacity=".95" />
            <stop offset=".45" stopColor="#20BCE5" stopOpacity=".55" />
            <stop offset="1" stopColor="#075B91" stopOpacity="0" />
          </radialGradient>
          {live && (
            <filter id={`${id}t`} x="-30%" y="-25%" width="160%" height="145%">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.035 0.085"
                numOctaves="2"
                seed="4"
                result="noise"
              >
                <animate
                  attributeName="baseFrequency"
                  dur="2.7s"
                  repeatCount="indefinite"
                  values="0.035 0.085;0.042 0.065;0.03 0.095;0.035 0.085"
                />
              </feTurbulence>
              <feDisplacementMap
                in="SourceGraphic"
                in2="noise"
                scale="5"
                xChannelSelector="R"
                yChannelSelector="G"
                result="warp"
              />
              <feGaussianBlur in="warp" stdDeviation="0.7" />
            </filter>
          )}
        </defs>
        <ellipse className="flame-halo" cx="32" cy="64" rx="36" ry="32" fill={`url(#${id}h)`} />
        <ellipse className="flame-base" cx="32" cy="85" rx="17" ry="5.5" fill={`url(#${id}b)`} />
        <g filter={live ? `url(#${id}t)` : undefined}>
          <path className="flame-outer" d={OUTER[0]} fill={`url(#${id}o)`} opacity=".9">
            {morph(OUTER, 1.75, 0)}
          </path>
          <path className="flame-middle" d={MIDDLE[0]} fill={`url(#${id}m)`}>
            {morph(MIDDLE, 1.3, 0.4)}
          </path>
        </g>
        <path className="flame-inner" d={INNER[0]} fill={`url(#${id}i)`}>
          {morph(INNER, 0.95, 0.2)}
        </path>
        <ellipse className="flame-core" cx="32" cy="76" rx="6" ry="8.5" fill={`url(#${id}c)`} />
        {live && (
          <g className="flame-tongues" fill="#FF963D">
            <path d="M0 0C2 -4 3 -7 0 -12C-3 -7 -2 -4 0 0Z" opacity="0">
              <animateTransform
                attributeName="transform"
                type="translate"
                values="40 30;43 12"
                dur="1.15s"
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                values="0;.85;0"
                dur="1.15s"
                repeatCount="indefinite"
              />
            </path>
            <path d="M0 0C1.6 -3 2.4 -6 0 -10C-2.4 -6 -1.6 -3 0 0Z" opacity="0" fill="#F04438">
              <animateTransform
                attributeName="transform"
                type="translate"
                values="25 34;21 16"
                dur="1.65s"
                begin="-0.6s"
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                values="0;.7;0"
                dur="1.65s"
                begin="-0.6s"
                repeatCount="indefinite"
              />
            </path>
          </g>
        )}
        {embers.map((e, i) => (
          <circle
            key={i}
            className="flame-ember"
            cx={e.x}
            cy={live ? 40 : 26 - i * 3}
            r={e.r}
            fill={i % 2 ? "#FFC15A" : "#FF963D"}
            opacity={live ? 0 : 0.8}
          >
            {live && (
              <>
                <animate
                  attributeName="cy"
                  values="44;-6"
                  dur={`${e.d}s`}
                  begin={`-${e.begin}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="cx"
                  values={`${e.x};${e.x + e.drift / 2};${e.x + e.drift}`}
                  dur={`${e.d}s`}
                  begin={`-${e.begin}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0;1;.8;0"
                  dur={`${e.d}s`}
                  begin={`-${e.begin}s`}
                  repeatCount="indefinite"
                />
              </>
            )}
          </circle>
        ))}
      </svg>
    </span>
  );
}
