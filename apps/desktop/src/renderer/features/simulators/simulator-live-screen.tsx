import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import {
  MAX_SIMULATOR_TEXT,
  type SimulatorDevice,
  type SimulatorInput,
} from "@zeros/protocol/simulators";

import { useWorkbenchStatusSource } from "../../shell/workbench/tab-status";
import { usePrefersReducedMotion } from "../../shared/ui/loading/use-prefers-reduced-motion";
import { toast } from "../../shared/ui/primitives/elements";
import {
  openSimulatorView,
  sendSimulatorInput,
  sendSimulatorTouch,
  type SimulatorView,
} from "./simulator-api";
import { listenToSimulatorFlashes } from "./simulator-capture-store";
import { decodeSimulatorFrame, LatestFramePainter } from "./simulator-frame-painter";
import {
  keystroke,
  mirroredFinger,
  pointOnScreen,
  scrollInput,
  turnedArea,
  unturn,
  type QuarterTurns,
  type Size,
} from "./simulator-geometry";
import { SimulatorFinger, SimulatorInputQueue, WheelSwipeGatherer } from "./simulator-input";
import { simulatorErrorMessage } from "./simulator-notices";
import {
  SimulatorAgentTouches,
  SimulatorPinchFingers,
  type SimulatorPinchFingersHandle,
} from "./simulator-touches";

/** One ordered input queue per device, shared by the screen and the island. */
export function useSimulatorInput(device: Pick<SimulatorDevice, "id" | "name">) {
  const queue = useRef<SimulatorInputQueue | null>(null);
  const name = useRef(device.name);
  name.current = device.name;
  const deviceId = device.id;
  useEffect(() => {
    const next = new SimulatorInputQueue(
      (input) => sendSimulatorInput(deviceId, input),
      (error) => {
        toast.error(simulatorErrorMessage(error, `Couldn't reach ${name.current}.`), {
          id: `simulator-input:${deviceId}`,
        });
      },
    );
    queue.current = next;
    return () => {
      next.dispose();
      if (queue.current === next) queue.current = null;
    };
  }, [deviceId]);
  return useCallback((input: SimulatorInput) => queue.current?.push(input), []);
}

/** Pixels in one wheel "line", as Chromium scrolls by. */
const WHEEL_LINE_PX = 40;

const FLASH_MS = 300;

/** The screen flashes white as a screenshot is taken, unless reduce motion
 * is on. */
function useScreenshotFlash(deviceId: string) {
  const flash = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  useEffect(() => {
    if (reducedMotion) return;
    let current: Animation | null = null;
    const stop = listenToSimulatorFlashes(deviceId, () => {
      const node = flash.current;
      if (!node) return;
      current?.cancel();
      node.hidden = false;
      const animation = node.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FLASH_MS,
        easing: "ease-out",
      });
      current = animation;
      const settle = () => {
        if (current !== animation) return;
        current = null;
        node.hidden = true;
      };
      animation.onfinish = settle;
      animation.oncancel = settle;
    });
    return () => {
      stop();
      current?.cancel();
    };
  }, [deviceId, reducedMotion]);
  return flash;
}

/** A running device's screen: frames while `live`, and the user's pointer,
 * wheel and keyboard as device input. The pointer reaches the device as it
 * moves, so a press is held and a drag followed there. Option-drag pinches
 * around the screen's center. While an agent uses the device, the user's
 * input waits and Esc goes up to the tab, which stops the agent. */
export function SimulatorLiveScreen({
  device,
  screen,
  turns,
  live,
  agentInControl,
  push,
}: {
  device: SimulatorDevice;
  /** The screen in points, upright. */
  screen: Size;
  /** How far the device is drawn turned. */
  turns: QuarterTurns;
  live: boolean;
  agentInControl: boolean;
  push: (input: SimulatorInput) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [painted, setPainted] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryWaiters = useRef<Array<() => void>>([]);
  const liveRef = useRef(live);
  liveRef.current = live;
  const name = useRef(device.name);
  name.current = device.name;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const pushRef = useRef(push);
  pushRef.current = push;
  const deviceId = device.id;
  const flash = useScreenshotFlash(deviceId);
  const view = useRef<SimulatorView | null>(null);
  const finger = useRef<SimulatorFinger | null>(null);
  const fingers = useRef<SimulatorPinchFingersHandle>(null);

  const retry = useCallback(
    () =>
      new Promise<void>((resolve) => {
        if (!liveRef.current) {
          resolve();
          return;
        }
        retryWaiters.current.push(resolve);
        setAttempt((value) => value + 1);
      }),
    [],
  );
  useWorkbenchStatusSource(
    { error: viewError, pending: opening, hasContent: painted, retry },
    `simulator-view:${deviceId}`,
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const settle = () => {
      for (const resolve of retryWaiters.current.splice(0)) resolve();
    };
    if (!live || !canvas || !context) {
      settle();
      return;
    }
    let disposed = false;
    let open: SimulatorView | null = null;
    const painter = new LatestFramePainter(decodeSimulatorFrame, (image, frame) => {
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      context.drawImage(image, 0, 0, frame.width, frame.height);
      setPainted(true);
    });
    setOpening(true);
    openSimulatorView(deviceId, (frame) => painter.push(frame)).then(
      (opened) => {
        if (disposed) {
          opened.close();
          return;
        }
        open = opened;
        view.current = opened;
        setViewError(null);
        setOpening(false);
        settle();
      },
      (error: unknown) => {
        if (disposed) return;
        setViewError(simulatorErrorMessage(error, `Zeros couldn't show ${name.current}.`));
        setOpening(false);
        settle();
      },
    );
    return () => {
      disposed = true;
      painter.dispose();
      if (open) {
        // Lifted before the view closes, so the device isn't left pressed.
        finger.current?.cancel();
        if (view.current === open) view.current = null;
        open.close();
      }
      setOpening(false);
      settle();
    };
  }, [live, deviceId, attempt]);

  useEffect(() => {
    const dots = fingers.current;
    const next = new SimulatorFinger({
      touch: (viewId, touch) => sendSimulatorTouch(deviceId, viewId, touch),
      push: (input) => pushRef.current(input),
      mirror: (at) => mirroredFinger(at, screenRef.current),
      onError: (error) => {
        toast.error(simulatorErrorMessage(error, `Couldn't reach ${name.current}.`), {
          id: `simulator-input:${deviceId}`,
        });
      },
      now: () => performance.now(),
    });
    finger.current = next;
    return () => {
      next.dispose();
      if (finger.current === next) finger.current = null;
      dots?.hide();
    };
  }, [deviceId]);

  useEffect(() => {
    if (!agentInControl) return;
    finger.current?.cancel();
    fingers.current?.hide();
  }, [agentInControl]);

  const gatherer = useRef<WheelSwipeGatherer | null>(null);
  useEffect(() => {
    const next = new WheelSwipeGatherer((at, delta) => {
      const swipe = scrollInput(at, delta, screenRef.current);
      if (swipe) push(swipe);
    });
    gatherer.current = next;
    return () => {
      next.dispose();
      if (gatherer.current === next) gatherer.current = null;
    };
  }, [push]);

  const pointAt = (event: { clientX: number; clientY: number; currentTarget: Element }) =>
    pointOnScreen(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      screenRef.current,
      turnsRef.current,
    );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const current = finger.current;
    if (event.button !== 0 || !current || current.pressed) return;
    // Focus even while the agent works, so Esc can stop it.
    event.currentTarget.focus({ preventScroll: true });
    if (agentInControl) return;
    const at = pointAt(event);
    if (!at) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const pinch = event.altKey;
    current.down(event.pointerId, view.current?.viewId ?? null, at, pinch);
    if (pinch) fingers.current?.show(at, screenRef.current);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = finger.current;
    if (!current?.holds(event.pointerId)) return;
    const at = pointAt(event);
    if (!at) return;
    current.move(event.pointerId, at);
    if (current.pinching) fingers.current?.show(at, screenRef.current);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = finger.current;
    if (!current?.holds(event.pointerId)) return;
    fingers.current?.hide();
    const at = pointAt(event);
    if (at) current.up(event.pointerId, at);
    else current.cancel();
  };
  const endPress = (event: PointerEvent<HTMLDivElement>) => {
    const current = finger.current;
    if (!current?.holds(event.pointerId)) return;
    current.cancel();
    fingers.current?.hide();
  };

  return (
    <div
      role="application"
      aria-label={`${device.name} screen`}
      tabIndex={0}
      data-simulator-live={painted ? "painted" : "waiting"}
      className="focus-visible:ring-highlighted-bright relative size-full touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-inset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endPress}
      onLostPointerCapture={endPress}
      onWheel={(event) => {
        // Pinch zoom arrives as a wheel with ctrlKey; it isn't a scroll.
        if (event.ctrlKey || agentInControl) return;
        const at = pointAt(event);
        if (!at) return;
        const upright = turnedArea(event.currentTarget.getBoundingClientRect(), turnsRef.current);
        const unit =
          event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? upright.height : 1;
        const pointsPerPixel = screenRef.current.width / upright.width;
        const delta = unturn({ x: event.deltaX, y: event.deltaY }, turnsRef.current);
        gatherer.current?.push(at, delta.x * unit * pointsPerPixel, delta.y * unit * pointsPerPixel);
      }}
      onKeyDown={(event) => {
        if (agentInControl) return;
        const stroke = keystroke({
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          isComposing: event.nativeEvent.isComposing,
        });
        if (!stroke) return;
        event.preventDefault();
        event.stopPropagation();
        push(stroke);
      }}
      onPaste={(event) => {
        if (agentInControl) return;
        const text = event.clipboardData.getData("text/plain").slice(0, MAX_SIMULATOR_TEXT);
        if (!text) return;
        event.preventDefault();
        push({ kind: "text", text });
      }}
    >
      <canvas ref={canvasRef} aria-hidden className="block size-full" />
      <SimulatorAgentTouches deviceId={deviceId} screen={screen} live={live} />
      <SimulatorPinchFingers ref={fingers} />
      {/* White in both themes without a color: whatever is behind is
          blacked out, then inverted. */}
      <div
        ref={flash}
        hidden
        aria-hidden
        data-simulator-flash=""
        className="pointer-events-none absolute inset-0 backdrop-brightness-0 backdrop-invert"
      />
    </div>
  );
}
