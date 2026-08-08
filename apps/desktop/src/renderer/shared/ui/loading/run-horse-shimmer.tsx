// Transparent dotted horse-and-rider loop used as the live Run indicator.
// The canvas paints only --blue-primary dots: no background, glow, gradient,
// or glitter. Motion defaults mirror the approved shape-shimmer study.

import { useEffect, useRef } from "react";

import { cn } from "@/renderer/shared/ui/cn";
import { isElementActuallyVisible } from "@/renderer/shared/lib/element-visibility";
import {
  RUN_HORSE_FRAME_COUNT,
  RUN_HORSE_MICRO_DEFAULTS,
  RUN_HORSE_MOTION_DEFAULTS,
  RUN_HORSE_TRANSITIONS,
  isRunHorseMicroDot,
} from "./run-horse-motion";

const TAU = Math.PI * 2;

interface CanvasLayout {
  deviceScale: number;
  grid: number;
  height: number;
  originX: number;
  originY: number;
  width: number;
}

const EMPTY_LAYOUT: CanvasLayout = {
  deviceScale: 1,
  grid: 1,
  height: 1,
  originX: 0,
  originY: 0,
  width: 1,
};

/** Fixed motion bounds keep the horse stable while its legs extend and gather.
 *  Source coordinates span x −14…14 and y −11…10; one grid-cell of air keeps
 *  edge dots from clipping at compact tab sizes. */
const VIEW_WIDTH = 30;
const VIEW_HEIGHT = 23;

export interface RunHorseShimmerProps {
  className?: string;
}

export function RunHorseShimmer({ className }: RunHorseShimmerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let animationFrame = 0;
    let color = getComputedStyle(canvas).color;
    let layout = EMPTY_LAYOUT;
    let progress = 0;
    let anchorTime = performance.now();

    const draw = (nextProgress: number) => {
      progress = ((nextProgress % 1) + 1) % 1;
      const { deviceScale, grid, height, originX, originY, width } = layout;
      context.clearRect(0, 0, width, height);

      const exactFrame = progress * RUN_HORSE_FRAME_COUNT;
      const frameIndex = Math.floor(exactFrame) % RUN_HORSE_FRAME_COUNT;
      const localProgress = exactFrame - Math.floor(exactFrame);
      const blend = RUN_HORSE_MOTION_DEFAULTS.frameBlend ? localProgress : 0;
      const maxRadius = Math.max(
        grid * 0.43 * RUN_HORSE_MOTION_DEFAULTS.dotScale,
        RUN_HORSE_MICRO_DEFAULTS.minimumPhysicalRadiusPx / deviceScale,
      );

      context.fillStyle = color;
      for (const dot of RUN_HORSE_TRANSITIONS[frameIndex]) {
        if (!isRunHorseMicroDot(dot.x, dot.y)) continue;
        const amount = dot.from + (dot.to - dot.from) * blend;
        if (amount < 0.018) continue;
        const x = originX + dot.x * grid;
        const y = originY + dot.y * grid;
        // At icon scale, encoding the blend solely in radius makes transitional
        // dots sub-pixel and effectively invisible. Keep a stable mark and fade
        // its opacity instead, preserving both motion and silhouette weight.
        const radius = maxRadius * (0.82 + amount * 0.18);
        context.globalAlpha = Math.sqrt(amount);
        context.beginPath();
        context.moveTo(x + radius, y);
        context.arc(x, y, radius, 0, TAU);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const deviceScale = Math.min(
        3,
        Math.max(1, window.devicePixelRatio || 1),
      );
      const pixelWidth = Math.round(width * deviceScale);
      const pixelHeight = Math.round(height * deviceScale);

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);

      const grid = Math.min(width / VIEW_WIDTH, height / VIEW_HEIGHT);
      layout = {
        deviceScale,
        grid,
        height,
        originX: width * 0.5,
        // The source bounds are centered at y = −0.5.
        originY: height * 0.5 + grid * 0.5,
        width,
      };
      draw(progress);
    };

    const tick = (now: number) => {
      // Retained hidden decks (collapsed terminal panels, background folders)
      // keep this canvas mounted; skip the repaint while it isn't rendered so
      // a run in a hidden surface doesn't cost a canvas draw every frame.
      // The rAF keeps running (cheap when it does nothing) so the shimmer
      // resumes seamlessly — with the correct phase — on the first visible
      // frame; elapsed derives from `now`, not from frames painted.
      const hidden = !isElementActuallyVisible(canvas);
      if (!hidden) {
        const elapsed =
          ((now - anchorTime) * RUN_HORSE_MOTION_DEFAULTS.speed) /
          RUN_HORSE_MOTION_DEFAULTS.cycleDurationMs;
        draw(elapsed);
      }
      animationFrame = window.requestAnimationFrame(tick);
    };

    const syncColor = () => {
      color = getComputedStyle(canvas).color;
      draw(progress);
    };

    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const syncMotionPreference = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      if (media?.matches) {
        draw(0);
        return;
      }
      anchorTime =
        performance.now() -
        (progress * RUN_HORSE_MOTION_DEFAULTS.cycleDurationMs) /
          RUN_HORSE_MOTION_DEFAULTS.speed;
      animationFrame = window.requestAnimationFrame(tick);
    };

    color = getComputedStyle(canvas).color;
    resize();

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    resizeObserver?.observe(canvas);
    if (!resizeObserver) window.addEventListener("resize", resize);

    const themeObserver = new MutationObserver(syncColor);
    themeObserver.observe(document.documentElement, {
      attributeFilter: ["class", "data-theme", "data-theme-palette", "style"],
      attributes: true,
    });

    media?.addEventListener("change", syncMotionPreference);
    syncMotionPreference();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", resize);
      themeObserver.disconnect();
      media?.removeEventListener("change", syncMotionPreference);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn(
        "zeros-run-horse-shimmer text-blue-primary block size-7 shrink-0",
        className,
      )}
      data-dot-density={RUN_HORSE_MICRO_DEFAULTS.dotDensity}
      data-dot-scale={RUN_HORSE_MOTION_DEFAULTS.dotScale}
      data-frame-blend={RUN_HORSE_MOTION_DEFAULTS.frameBlend}
      data-glitter-strength={RUN_HORSE_MOTION_DEFAULTS.glitterStrength}
      data-loop-speed={RUN_HORSE_MOTION_DEFAULTS.speed}
      height={56}
      width={56}
    />
  );
}
