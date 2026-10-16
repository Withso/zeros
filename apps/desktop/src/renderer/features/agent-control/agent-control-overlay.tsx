import { useCallback, useEffect, useState } from "react";

import type { AgentControlOverlayState } from "../../../../electron/agent-control/channels";
import { AgentControlBar } from "./agent-control-bar";

/** What `agent-control-preload` exposes to the bar page. */
export interface AgentControlOverlayBridge {
  /** Subscribes, then asks main for the current state. */
  onState(listener: (state: unknown) => void): () => void;
  stop(): void;
  /** Whether the pointer is over Stop. The computer-use bar floats over
   * other apps and lets every other click through. */
  setInteractive?(interactive: boolean): void;
}

const HIDDEN: AgentControlOverlayState = {
  title: "",
  detail: "",
  visible: false,
};

export function readAgentControlOverlayState(
  value: unknown,
): AgentControlOverlayState | null {
  if (!value || typeof value !== "object") return null;
  const { title, detail, visible } = value as Record<string, unknown>;
  if (
    typeof title !== "string" ||
    typeof detail !== "string" ||
    typeof visible !== "boolean"
  ) {
    return null;
  }
  return { title, detail, visible };
}

/** The same Esc the controlled page answers to (`browserInputStopsAgent`). */
export function isAgentControlStopKey(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing"
  >,
): boolean {
  return (
    event.key === "Escape" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.isComposing
  );
}

/** Stop is the only control in the pill. */
export function isAgentControlStopTarget(target: EventTarget | null): boolean {
  const element = target as Partial<Pick<Element, "closest">> | null;
  return (
    typeof element?.closest === "function" &&
    element.closest("button:not(:disabled)") !== null
  );
}

/** The pill inside the transparent view main sizes with
 * `agentControlOverlayBounds`; the padding leaves room for its shadow. */
export function AgentControlOverlayFrame({
  state,
  stopping,
  onStop,
}: {
  state: AgentControlOverlayState;
  stopping: boolean;
  onStop: () => void;
}) {
  return (
    <div className="flex h-screen items-end justify-center px-6 pb-4">
      <AgentControlBar
        variant="pill"
        title={state.title}
        detail={state.detail}
        visible={state.visible}
        stopLabel={`Stop ${state.title}`}
        stopping={stopping}
        onStop={onStop}
        escapeHint
      />
    </div>
  );
}

export function AgentControlOverlay({
  bridge,
}: {
  bridge: AgentControlOverlayBridge;
}) {
  const [state, setState] = useState(HIDDEN);
  const [stopping, setStopping] = useState(false);

  useEffect(
    () =>
      bridge.onState((value) => {
        const next = readAgentControlOverlayState(value);
        if (!next) return;
        setState(next);
        setStopping(false);
      }),
    [bridge],
  );

  const stop = useCallback(() => {
    setStopping(true);
    bridge.stop();
  }, [bridge]);

  useEffect(() => {
    if (!state.visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isAgentControlStopKey(event)) return;
      event.preventDefault();
      stop();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.visible, stop]);

  useEffect(() => {
    const setInteractive = bridge.setInteractive?.bind(bridge);
    if (!setInteractive || !state.visible) return;
    let interactive = false;
    const report = (next: boolean) => {
      if (next === interactive) return;
      interactive = next;
      setInteractive(next);
    };
    const onPointerMove = (event: PointerEvent) =>
      report(isAgentControlStopTarget(event.target));
    const onPointerLeave = () => report(false);
    window.addEventListener("pointermove", onPointerMove);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener(
        "pointerleave",
        onPointerLeave,
      );
      report(false);
    };
  }, [bridge, state.visible]);

  return (
    <AgentControlOverlayFrame state={state} stopping={stopping} onStop={stop} />
  );
}
