// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  publishDesignLivePreviewStyles,
  resetDesignLivePreviewForTests,
  useDesignLivePreviewStyles,
} from "../state/design-live-preview";
import {
  clearDesignHistoryPresentation,
  presentDesignHistory,
  presentDesignHistoryRuntime,
  setDesignHistoryPresentationOwnerReader,
} from "../state/design-history-presentation";
import { resetDesignWorkspaceUiForTests } from "../state/design-workspace-ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function presentInverse(workspace: string, sequence: number) {
  const token = {};
  presentDesignHistory(workspace, token, {});
  const detail = { sourceVersion: "before", oid: "hero", tag: "div", name: "Hero", text: null,
    selector: "div", breadcrumb: [], visible: true, styles: { gap: "0px" },
    rect: { x: 0, y: 0, width: 100, height: 100 } };
  presentDesignHistoryRuntime(workspace, token, "home.html", {
    sourceVersion: "before", snapshot: { frame: { ...detail, oid: "body" } }, details: [detail],
  }, sequence);
}

const readsGap = (property: string) => property === "gap";
let container: HTMLDivElement;
let root: Root;
const seen: (Readonly<Record<string, string | null>> | undefined)[] = [];

function Probe({ reads }: { reads?: (property: string) => boolean }) {
  seen.push(useDesignLivePreviewStyles("workspace-a", "home.html", "hero", reads));
  return null;
}

async function mount(reads?: (property: string) => boolean) {
  await act(async () => root.render(React.createElement(Probe, { reads })));
}

const publish = (styles: Record<string, string>) =>
  act(() => publishDesignLivePreviewStyles("workspace-a", "home.html", "hero", styles));

describe("an owner's live styles in a section", () => {
  beforeEach(() => {
    resetDesignLivePreviewForTests();
    resetDesignWorkspaceUiForTests();
    clearDesignHistoryPresentation();
    setDesignHistoryPresentationOwnerReader(() => "owner-a");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    seen.length = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetDesignLivePreviewForTests();
    clearDesignHistoryPresentation();
    setDesignHistoryPresentationOwnerReader(() => "");
  });

  it("re-renders only for the properties it reads, keeping one reference between them", async () => {
    await mount(readsGap);
    for (let tick = 1; tick <= 20; tick += 1) publish({ opacity: String(tick / 20) });
    expect(seen).toEqual([undefined]);
    publish({ gap: "8px" });
    expect(seen.at(-1)).toEqual({ gap: "8px" });
    const renders = seen.length;
    const shown = seen.at(-1);
    for (let tick = 1; tick <= 20; tick += 1) publish({ opacity: String(tick / 20) });
    expect(seen.length).toBe(renders);
    publish({ gap: "9px" });
    expect(seen.at(-1)).toEqual({ gap: "9px" });
    expect(seen.at(-1)).not.toBe(shown);
  });

  it.each([
    ["every property", undefined],
    ["the properties it reads", readsGap],
  ])("shows a value re-entered after Undo again when reading %s", async (_, reads) => {
    await mount(reads);
    let publication: Record<string, number> = {};
    act(() => {
      publication = publishDesignLivePreviewStyles("workspace-a", "home.html", "hero", { gap: "8px" });
    });
    expect(seen.at(-1)).toEqual({ gap: "8px" });
    act(() => presentInverse("workspace-a", publication.gap!));
    expect(seen.at(-1)).toBeUndefined();
    publish({ gap: "8px" });
    expect(seen.at(-1)).toEqual({ gap: "8px" });
  });
});
