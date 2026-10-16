import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { SimulatorPoint } from "@zeros/protocol/simulators";

import { usePrefersReducedMotion } from "../../shared/ui/loading/use-prefers-reduced-motion";
import { listenToSimulatorAgentTouches } from "./simulator-agent-store";
import { mirroredFinger, type Size } from "./simulator-geometry";
import { screenSpot, touchDots } from "./simulator-touch-motion";

const FINGER =
  "bg-muted-fg/50 border-fg1/25 pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border";
/** Invisible until its animation shows it, so a delayed dot waits unseen. */
const AGENT_DOT =
  "bg-muted-fg/50 border-fg1/25 pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border opacity-0";

/** A burst of actions draws at most this many dots at once. */
const MAX_AGENT_DOTS = 12;

/** Where an agent touches the device, over its screen while `live`. Dots
 * are drawn straight into the page and removed as they fade. */
export function SimulatorAgentTouches({
  deviceId,
  screen,
  live,
}: {
  deviceId: string;
  /** The screen in points. */
  screen: Size;
  live: boolean;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const reducedMotion = usePrefersReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  useEffect(() => {
    const element = layer.current;
    if (!live || !element) return;
    const running = new Set<Animation>();
    const stop = listenToSimulatorAgentTouches(deviceId, (touch) => {
      for (const dot of touchDots(touch, screenRef.current, reducedMotionRef.current)) {
        while (element.childElementCount >= MAX_AGENT_DOTS) element.firstElementChild?.remove();
        const node = document.createElement("div");
        node.className = AGENT_DOT;
        element.append(node);
        const animation = node.animate(dot.keyframes, dot.options);
        running.add(animation);
        const done = () => {
          running.delete(animation);
          node.remove();
        };
        animation.addEventListener("finish", done);
        animation.addEventListener("cancel", done);
      }
    });
    return () => {
      stop();
      for (const animation of [...running]) animation.cancel();
      element.replaceChildren();
    };
  }, [deviceId, live]);

  return (
    <div
      ref={layer}
      aria-hidden
      data-simulator-agent-touches=""
      className="pointer-events-none absolute inset-0 overflow-hidden"
    />
  );
}

export interface SimulatorPinchFingersHandle {
  /** Shows the pointer's finger and its mirror through the screen's center. */
  show(finger: SimulatorPoint, screen: Size): void;
  hide(): void;
}

/** The two fingers of the user's Option-drag pinch. */
export const SimulatorPinchFingers = forwardRef<SimulatorPinchFingersHandle>(
  function SimulatorPinchFingers(_props, ref) {
    const first = useRef<HTMLDivElement>(null);
    const second = useRef<HTMLDivElement>(null);
    useImperativeHandle(
      ref,
      () => ({
        show(finger, screen) {
          const place = (node: HTMLDivElement | null, point: SimulatorPoint) => {
            if (!node) return;
            const spot = screenSpot(point, screen);
            node.style.left = `${spot.left}%`;
            node.style.top = `${spot.top}%`;
            node.hidden = false;
          };
          place(first.current, finger);
          place(second.current, mirroredFinger(finger, screen));
        },
        hide() {
          if (first.current) first.current.hidden = true;
          if (second.current) second.current.hidden = true;
        },
      }),
      [],
    );
    return (
      <div aria-hidden data-simulator-pinch="" className="pointer-events-none absolute inset-0">
        <div ref={first} hidden className={FINGER} />
        <div ref={second} hidden className={FINGER} />
      </div>
    );
  },
);
