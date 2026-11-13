// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFocusRefresh } from "../use-focus-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Array<{ unmount(): void }> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { act(() => roots.splice(0).forEach(root => root.unmount())); vi.useRealTimers(); });

it("R1: refreshes when the window regains focus and otherwise only every 60 s, and only while active", async () => {
  const refresh = vi.fn();
  function Probe({ active }: { active: boolean }) { useFocusRefresh(active, refresh); return null; }
  const root = createRoot(document.createElement("div")); roots.push(root);
  act(() => root.render(createElement(Probe, { active: true })));
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(refresh).toHaveBeenCalledTimes(2);
  act(() => { window.dispatchEvent(new Event("focus")); });
  expect(refresh).toHaveBeenCalledTimes(3);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(refresh).toHaveBeenCalledTimes(4);
  act(() => root.render(createElement(Probe, { active: false })));
  act(() => { window.dispatchEvent(new Event("focus")); });
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(refresh).toHaveBeenCalledTimes(4);
});
