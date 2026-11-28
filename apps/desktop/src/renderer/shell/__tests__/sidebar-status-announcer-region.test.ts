// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useSidebarStatusAnnouncement, type SidebarStatusAnnouncementRow } from "../sidebar-status-announcer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Region({ rows }: { rows: readonly SidebarStatusAnnouncementRow[] | null }) {
  return createElement("div", { role: "status" }, useSidebarStatusAnnouncement(rows));
}
const shown = (rows: readonly SidebarStatusAnnouncementRow[] | null) => {
  act(() => root.render(createElement(Region, { rows })));
  return host.querySelector('[role="status"]')!.textContent;
};
const atlas = (status: string | null) => [{ id: "a", label: "atlas", status }];

describe("the sidebar's status region", () => {
  // The region is cleared on a pass with no change, so a second change to the
  // same word (idle → Working → idle → Working) is new text and is announced.
  it("announces a repeated change to the same status again", () => {
    expect(shown(atlas(null))).toBe("");
    expect(shown(atlas("Working"))).toBe("atlas: Working");
    expect(shown(atlas(null))).toBe("");
    expect(shown(atlas("Working"))).toBe("atlas: Working");
  });

  it("goes quiet and starts fresh while the sidebar is hidden", () => {
    shown(atlas(null));
    expect(shown(atlas("Working"))).toBe("atlas: Working");
    expect(shown(null)).toBe("");
    // First sighting after a hidden spell sets the baseline without speaking.
    expect(shown(atlas("Needs input"))).toBe("");
  });
});
