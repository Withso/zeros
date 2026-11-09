// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { useWorkspaceDetailsOpen } from "../conversation/workspace-identity";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: { unmount: () => void }[] = [];
afterEach(() => act(() => roots.splice(0).forEach(root => root.unmount())));

// The shell keeps the workspace layer mounted, inert and invisible, while
// Settings or Home shows, so the header's popup state survives the trip.
it("closes a workspace's details when its page hides and keeps them closed when it returns", () => {
  let details: readonly [boolean, (open: boolean) => void] = [false, () => {}];
  function Probe({ active }: { active: boolean }) {
    details = useWorkspaceDetailsOpen(active);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(createElement(Probe, { active: true })));
  act(() => details[1](true));
  expect(details[0]).toBe(true);
  act(() => root.render(createElement(Probe, { active: false })));
  expect(details[0]).toBe(false);
  act(() => root.render(createElement(Probe, { active: true })));
  expect(details[0]).toBe(false);
  act(() => details[1](true));
  expect(details[0]).toBe(true);
});
