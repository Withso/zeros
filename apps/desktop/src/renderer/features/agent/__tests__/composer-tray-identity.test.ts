// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ComposerTray } from "../composer-tray";

it("keeps the composer mounted when the tray's message appears and clears", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const mounts = vi.fn();
  function Composer() {
    useEffect(() => { mounts(); }, []);
    return createElement("div", { "data-card": "" });
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (message: string | null) =>
    act(() => root.render(createElement(ComposerTray, { message }, createElement(Composer))));
  render(null);
  render("Checking Cloud availability…");
  render(null);
  expect(mounts).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});
