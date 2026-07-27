// Five-story dotted loop (cat + mouse, rolling eyes, rower, train, sunrise)
// used EXCLUSIVELY as the agent "thinking" tail indicator next to the live
// timer (ActivityShimmer in activity-hud.tsx). Do not mount it anywhere else:
// terminal Run indicators keep RunHorseShimmer and generic loading keeps
// ZerosSpinner.
//
// The canvas paints --fg2 dots with a narrow --fg1 highlight band traveling
// across each scene: no background, glow, gradient, or random glitter.
// Motion and tuning mirror the approved shape-shimmer study.

import { useEffect, useRef } from "react";

import { cn } from "@/zeros/ui/cn";
import {
  STORY_SHIMMER_FRAME_COUNT,
  STORY_SHIMMER_MICRO_DEFAULTS,
  STORY_SHIMMER_MOTION_DEFAULTS,
  STORY_SHIMMER_SCENE_FRAME_COUNT,
  STORY_SHIMMER_TRANSITIONS,
  STORY_SHIMMER_VIEW_SIZE,
  storyShimmerProjection,
} from "./story-shimmer-motion";

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

export interface StoryShimmerProps {
  className?: string;
  /** Accessible name. When set, the canvas is exposed as role="img";
   *  otherwise it is aria-hidden decoration. */
  label?: string;
  /** Square CSS size in px. Defaults to the authored 24px, where the
   *  12-column grid lands on an exact 2px dot pitch. */
  size?: number;
}

export function StoryShimmer({
  className,
  label,
  size = STORY_SHIMMER_MICRO_DEFAULTS.cssSizePx,
}: StoryShimmerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let animationFrame = 0;
    let baseColor = "";
    let highlightColor = "";
    let layout = EMPTY_LAYOUT;
    let progress = 0;
    let anchorTime = performance.now();

    const draw = (nextProgress: number) => {
      progress = ((nextProgress % 1) + 1) % 1;
      const { deviceScale, grid, height, originX, originY, width } = layout;
      context.clearRect(0, 0, width, height);

      const exactFrame = progress * STORY_SHIMMER_FRAME_COUNT;
      const frameIndex = Math.floor(exactFrame) % STORY_SHIMMER_FRAME_COUNT;
      const localProgress = exactFrame - Math.floor(exactFrame);
      const blend = STORY_SHIMMER_MOTION_DEFAULTS.frameBlend
        ? localProgress
        : 0;
      const isMicro =
        width <= STORY_SHIMMER_MICRO_DEFAULTS.maxMicroCssSizePx &&
        height <= STORY_SHIMMER_MICRO_DEFAULTS.maxMicroCssSizePx;
      const baseRadius = Math.max(
        grid *
          STORY_SHIMMER_MOTION_DEFAULTS.dotRadius *
          STORY_SHIMMER_MOTION_DEFAULTS.dotScale,
        isMicro
          ? STORY_SHIMMER_MICRO_DEFAULTS.minimumMicroCssRadiusPx
          : STORY_SHIMMER_MICRO_DEFAULTS.minimumPhysicalRadiusPx / deviceScale,
      );
      const snapScale = Math.max(1, deviceScale);
      const sceneProgress =
        (exactFrame % STORY_SHIMMER_SCENE_FRAME_COUNT) /
        STORY_SHIMMER_SCENE_FRAME_COUNT;
      const shimmerCenter = -0.22 + sceneProgress * 1.44;

      interface ActiveDot {
        alpha: number;
        canvasX: number;
        canvasY: number;
        radius: number;
        shimmerAmount: number;
      }
      const activeDots: ActiveDot[] = [];

      for (const dot of STORY_SHIMMER_TRANSITIONS[frameIndex]) {
        const alpha = dot.fromAlpha + (dot.toAlpha - dot.fromAlpha) * blend;
        const radiusScale =
          dot.fromRadius + (dot.toRadius - dot.fromRadius) * blend;
        if (alpha < 0.015 || radiusScale < 0.05) continue;

        const rawCanvasX = originX + dot.x * grid;
        const rawCanvasY = originY + dot.y * grid;
        // A physical-pixel center (n + 0.5), rather than an intersection,
        // keeps neighboring Retina dots from rasterizing as touching blocks.
        const canvasX = isMicro
          ? (Math.floor(rawCanvasX * snapScale) + 0.5) / snapScale
          : rawCanvasX;
        const canvasY = isMicro
          ? (Math.floor(rawCanvasY * snapScale) + 0.5) / snapScale
          : rawCanvasY;
        const distance = Math.abs(
          storyShimmerProjection(dot.x, dot.y) - shimmerCenter,
        );
        const shimmerAmount =
          Math.exp(-((distance / 0.115) ** 2)) *
          STORY_SHIMMER_MOTION_DEFAULTS.shimmerIntensity;

        activeDots.push({
          alpha,
          canvasX,
          canvasY,
          radius: baseRadius * radiusScale,
          shimmerAmount,
        });
      }

      context.fillStyle = baseColor;
      for (const dot of activeDots) {
        context.globalAlpha = dot.alpha;
        context.beginPath();
        context.arc(dot.canvasX, dot.canvasY, dot.radius, 0, TAU);
        context.fill();
      }

      context.fillStyle = highlightColor;
      for (const dot of activeDots) {
        if (dot.shimmerAmount < 0.015) continue;
        context.globalAlpha = dot.alpha * dot.shimmerAmount;
        context.beginPath();
        context.arc(dot.canvasX, dot.canvasY, dot.radius, 0, TAU);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width || size));
      const height = Math.max(1, Math.round(bounds.height || size));
      const deviceScale = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const pixelWidth = Math.round(width * deviceScale);
      const pixelHeight = Math.round(height * deviceScale);

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);

      layout = {
        deviceScale,
        grid: Math.min(
          width / STORY_SHIMMER_VIEW_SIZE,
          height / STORY_SHIMMER_VIEW_SIZE,
        ),
        height,
        originX: width * 0.5,
        originY: height * 0.5,
        width,
      };
      draw(progress);
    };

    const tick = (now: number) => {
      const elapsed =
        ((now - anchorTime) * STORY_SHIMMER_MOTION_DEFAULTS.speed) /
        STORY_SHIMMER_MOTION_DEFAULTS.cycleDurationMs;
      draw(elapsed);
      animationFrame = window.requestAnimationFrame(tick);
    };

    const syncColors = () => {
      const style = getComputedStyle(canvas);
      baseColor = style.getPropertyValue("--fg2").trim() || style.color;
      highlightColor = style.getPropertyValue("--fg1").trim() || style.color;
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
        (progress * STORY_SHIMMER_MOTION_DEFAULTS.cycleDurationMs) /
          STORY_SHIMMER_MOTION_DEFAULTS.speed;
      animationFrame = window.requestAnimationFrame(tick);
    };

    syncColors();
    resize();

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    resizeObserver?.observe(canvas);
    if (!resizeObserver) window.addEventListener("resize", resize);

    const themeObserver = new MutationObserver(syncColors);
    themeObserver.observe(document.documentElement, {
      attributeFilter: ["class", "data-theme", "style"],
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
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("zeros-story-shimmer block shrink-0", className)}
      style={{ height: size, width: size }}
      data-frame-blend={STORY_SHIMMER_MOTION_DEFAULTS.frameBlend}
      data-loop-speed={STORY_SHIMMER_MOTION_DEFAULTS.speed}
      data-shimmer-strength={STORY_SHIMMER_MOTION_DEFAULTS.shimmerIntensity}
      height={size * 2}
      width={size * 2}
    />
  );
}
