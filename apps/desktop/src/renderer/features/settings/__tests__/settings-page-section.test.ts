// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsGroup, SettingsPageSection, SettingsSection } from "../settings-ui";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const texts = (selector: string) => [...container.querySelectorAll(selector)].map(node => node.textContent);

describe("settings page sections", () => {
  it("puts sections one level below the page section and drops a title that repeats it", () => {
    act(() => root.render(h(SettingsPageSection, {
      title: "Files to copy", description: "Copied into new workspaces.",
      children: [h(SettingsSection, { key: "a", title: "Files to copy", description: "Kept" }, "a"),
        h(SettingsGroup, { key: "b", title: "Branch", children: "b" })],
    })));
    expect(texts("h2")).toEqual(["Files to copy"]);
    expect(texts("h3")).toEqual(["Branch"]);
    expect(container.textContent).toContain("Kept");
  });

  it("keeps standalone sections at their own level", () => {
    act(() => root.render(h(SettingsSection, { title: "Files to copy", children: "a" })));
    expect(texts("h2")).toEqual(["Files to copy"]);
    expect(texts("h3")).toEqual([]);
  });
});
