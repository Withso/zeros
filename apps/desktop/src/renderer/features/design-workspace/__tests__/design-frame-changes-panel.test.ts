// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: vi.fn(), waitForDesignFrameRuntime: vi.fn() }));
vi.mock("../../../state/workspace-store", () => ({ useWorkspaceDispatch: () => vi.fn() }));
vi.mock("../../../shell/workbench/file-pill-navigation", () => ({ openFilePill: vi.fn(), warmFilePill: vi.fn() }));

import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignFrameChangesPanel } from "../design-frame-changes-panel";
import {
  designFrameChangesKey,
  resetDesignFrameChangesForTests,
  useDesignFrameChangesStore,
  useDesignTidyStore,
  type DesignFrameChange,
  type DesignTidyEntry,
} from "../state/design-frame-changes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = designFrameChangesKey("ws", "home.html");
const replaced = { origin: "frame" as const, selector: ".btn", subjectClasses: ["btn"], value: "6px" };
const CHANGES: DesignFrameChange[] = [
  { oid: "send", layer: "Send", field: "Corner radius", property: "border-radius", value: "8px", replaced },
  { oid: "card", layer: "Card", field: "Gap", property: "row-gap", value: "12px", replaced },
];

let container: HTMLDivElement;
let root: Root;

function render(): HTMLElement {
  act(() => {
    root.render(createElement(TooltipProvider, null, createElement(DesignFrameChangesPanel, {
      workspaceId: "ws", folder: "/repo", frame: "home.html", directory: "design", active: false, onAskAgent: vi.fn(),
    })));
  });
  return container.querySelector<HTMLElement>("[data-design-frame-info]")!;
}
const tidy = (entry: DesignTidyEntry) => useDesignTidyStore.setState({ byKey: { [KEY]: entry } });
const buttons = (info: HTMLElement) => [...info.querySelectorAll("button")].map((button) => button.textContent?.trim());

beforeEach(() => {
  resetDesignFrameChangesForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the frame changes panel", () => {
  it("is one row: the count by hand and Tidy, with which fields as the title's tooltip and no body", () => {
    useDesignFrameChangesStore.setState({ byKey: { [KEY]: { sourceVersion: "v1", changes: CHANGES, truncated: true } } });
    const info = render();
    expect(info.getAttribute("data-design-frame-info")).toBe("waiting");
    const title = info.querySelector<HTMLElement>("[data-design-frame-info-title]")!;
    expect(title.textContent).toBe("2 changes by hand");
    expect(info.querySelector("p")).toBeNull();
    expect(info.textContent).not.toContain("Corner radius");
    expect(buttons(info)).toEqual(["Tidy"]);
    // The title carries the hover tooltip; keyboard and screen-reader users
    // get the same detail from the row's one button, not a focusable span.
    expect(title.getAttribute("data-state")).toBe("closed");
    expect(title.hasAttribute("tabindex")).toBe(false);
    expect(title.hasAttribute("aria-description")).toBe(false);
    const button = info.querySelector("button")!;
    expect(button.getAttribute("aria-description")).toBe("Corner radius and Gap, on 2 layers. Not every layer was checked, so there may be more.");
    expect(button.getAttribute("data-state")).toBe("closed");
  });

  it("shows a title and View chat while Tidy runs, and a title and Review when it is done", () => {
    tidy({ phase: "running", chatId: "chat-1", before: CHANGES });
    let info = render();
    expect(info.getAttribute("data-design-frame-info")).toBe("running");
    expect(info.querySelector("[data-design-frame-info-title]")?.textContent).toBe("Tidying 2 changes");
    expect(info.querySelector("p")).toBeNull();
    expect(buttons(info)).toEqual(["View chat"]);
    expect(info.querySelector("button")!.getAttribute("aria-description")).toBe("The agent is moving them into tokens, classes or the component.");

    tidy({ phase: "done", chatId: "chat-1", before: CHANGES, outcome: "2 stay on their layer. Nothing is committed." });
    info = render();
    expect(info.getAttribute("data-design-frame-info")).toBe("done");
    expect(info.querySelector("[data-design-frame-info-title]")?.textContent).toBe("Tidied");
    expect(info.querySelector("p")).toBeNull();
    expect(info.textContent).not.toContain("Nothing is committed");
    expect(buttons(info)).toEqual(["Review"]);
    expect(info.querySelector("button")!.getAttribute("aria-description")).toBe("2 stay on their layer. Nothing is committed.");
  });
});
