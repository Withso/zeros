import { useEffect, useState } from "react";

import { cn } from "@/zeros/ui/cn";
import {
  RUN_WAVE_BAR_VALUES,
  RUN_WAVE_KEY_TIMES,
  RUN_WAVE_MOTION,
  runWaveStrokeWidth,
} from "./run-wave-motion";

const VIEWBOX_SIZE = 20;
const BASELINE_Y = 18;
const STROKE_HEIGHT = 14;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const sync = () => setReduced(media.matches);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return reduced;
}

export interface RunWaveProps {
  /** Square icon size in CSS pixels. */
  size?: number;
  className?: string;
  /** Optional standalone accessible name. Decorative uses should omit this. */
  label?: string;
}

/** Five real rounded SVG line strokes. Their bottoms share one fixed baseline
 * while only their top endpoints form the traveling wave; colour inherits
 * currentColor. */
export function RunWave({ size = 16, className, label }: RunWaveProps) {
  const reducedMotion = usePrefersReducedMotion();
  const firstPose = RUN_WAVE_MOTION.poses[0];

  return (
    <svg
      className={cn("block shrink-0 overflow-visible", className)}
      data-run-wave=""
      data-animated={reducedMotion ? undefined : "true"}
      viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
      width={size}
      height={size}
      // `size` also has to WIN, not just be declared. width/height are
      // presentation attributes, which any author rule outranks — and this
      // icon's whole job is to sit inside buttons and tabs, several of which
      // carry a blanket `[&_svg]:size-*` (the top-bar workspace tab's Button
      // is `[&_svg]:size-3.5`). Without this an inherited utility silently
      // resizes the box while runWaveStrokeWidth(size) keeps weighting the
      // stroke for the size the caller asked for, so the two disagree.
      style={{ width: size, height: size }}
      fill="none"
      focusable="false"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
    >
      {RUN_WAVE_MOTION.bars.map((bar, index) => {
        const restingScale = reducedMotion ? bar.rest : firstPose[index];
        return (
          <g key={bar.x} transform={`translate(${bar.x} ${BASELINE_Y})`}>
            <line
              x1="0"
              x2="0"
              y1={-STROKE_HEIGHT}
              y2="0"
              fill="none"
              stroke="currentColor"
              strokeWidth={runWaveStrokeWidth(size)}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              transform={`scale(1 ${restingScale})`}
            >
              {!reducedMotion && (
                <animateTransform
                  attributeName="transform"
                  type="scale"
                  values={RUN_WAVE_BAR_VALUES[index]}
                  keyTimes={RUN_WAVE_KEY_TIMES}
                  dur={`${RUN_WAVE_MOTION.cycleDurationMs}ms`}
                  calcMode="linear"
                  repeatCount="indefinite"
                />
              )}
            </line>
          </g>
        );
      })}
    </svg>
  );
}
