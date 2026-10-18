import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ActivityScope } from "../shared/ui/loading/activity-scope";
import { ActivityShimmer } from "../shared/ui/loading/activity-shimmer";
import { LiveDuration } from "../shared/ui/loading/live-duration";
import { ZerosSpinner } from "../shared/ui/loading/zeros-spinner";
import { RunStream } from "../shared/ui/loading/run-stream";

const local = new URLSearchParams(location.search).get("legacy") !== "1";
const wallTime = Date.now;
let elapsedShift = 0;
Date.now = () => wallTime() + elapsedShift;
const startedAt = Date.now() - 5_400_000;
let focused = true, visible = true;
// Foreground events are synthetic; the SVG, viewport intersection, retained
// visibility, media query and animation ownership use the actual browser.
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visible ? "visible" : "hidden" });
document.hasFocus = () => focused;

declare global {
  interface Window {
    loaderActivityFixture: {
      foreground: (show: boolean, focus: boolean) => void;
      retain: (active: boolean) => void;
      move: (offscreen: boolean) => void;
      hide: (hidden: boolean) => void;
      elapse: (ms: number) => void;
      shimmerPhaseGap: () => number;
      unmount: () => void;
    };
  }
}
function Fixture() {
  const [active, setActive] = useState(true);
  window.loaderActivityFixture.retain = next => flushSync(() => setActive(next));
  return <ActivityScope.Provider value={local ? active : undefined}>
    <main id="activity-owner" className="flex items-center gap-6 p-6 text-fg1" style={{ position: "absolute", top: 0 }}>
      <ZerosSpinner variant="orbit" />
      <ZerosSpinner variant="agent" />
      <ZerosSpinner variant="glass" motion="circuit" />
      <RunStream />
      <LiveDuration startedAt={startedAt} />
      <ActivityShimmer startedAt={startedAt} gibberish />
    </main>
  </ActivityScope.Provider>;
}
const root = createRoot(document.getElementById("root")!);
window.loaderActivityFixture = {
  foreground: (show, focus) => {
    visible = show; focused = focus;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(focus ? "focus" : "blur"));
  },
  retain: () => {},
  move: offscreen => { document.getElementById("activity-owner")!.style.top = offscreen ? "2000px" : "0"; },
  hide: hidden => { document.getElementById("activity-owner")!.style.visibility = hidden ? "hidden" : "visible"; },
  elapse: ms => { elapsedShift += ms; },
  shimmerPhaseGap: () => {
    const element = document.querySelector(".zeros-gibberish-thinking")!;
    const progress = element.getAnimations()[0]?.effect?.getComputedTiming().progress ?? -1;
    const expected = ((Date.now() - startedAt) % 3_000) / 3_000;
    const gap = Math.abs(expected - progress);
    return Math.min(gap, 1 - gap);
  },
  unmount: () => flushSync(() => root.unmount()),
};
flushSync(() => root.render(<Fixture />));
