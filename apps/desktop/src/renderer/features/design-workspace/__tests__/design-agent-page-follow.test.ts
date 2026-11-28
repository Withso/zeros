import { describe, expect, it } from "vitest";
import { updateDesignAgentPageFollow, type DesignAgentPageFollowMemory } from "../state/design-agent-page-follow";
import { resetDesignWorkspaceUiForTests, useDesignWorkspaceUiStore, designWorkspaceView, bindDesignWorkspacePages } from "../state/design-workspace-ui";

const pageA = { id: "page_a", title: "Alpha", folder: "alpha", frameFiles: [] };
const pageB = { id: "page_b", title: "Beta", folder: "beta", frameFiles: [] };
const pageC = { id: "page_c", title: "Gamma", folder: "gamma", frameFiles: [] };

function input(overrides: Partial<Parameters<typeof updateDesignAgentPageFollow>[1]> = {}) {
  return {
    active: true,
    turnActive: false,
    directoryId: "design",
    activePageId: "page_a",
    pages: [pageA],
    navigationEvent: 0,
    ...overrides,
  };
}

describe("Design agent page follow", () => {
  it("switches once to a page added during the active focused turn", () => {
    let memory: DesignAgentPageFollowMemory | null = null;
    memory = updateDesignAgentPageFollow(memory, input()).memory;
    memory = updateDesignAgentPageFollow(memory, input({ turnActive: true })).memory;
    const added = updateDesignAgentPageFollow(memory, input({ turnActive: true, pages: [pageA, pageB] }));
    expect(added.switchToPageId).toBe("page_b");
    memory = added.memory;
    const repeated = updateDesignAgentPageFollow(memory, input({ turnActive: true, pages: [pageA, pageB], activePageId: "page_b" }));
    expect(repeated.switchToPageId).toBeUndefined();
  });

  it("does not switch on relaunch, ordinary refreshes, or when first focused mid-turn", () => {
    let memory: DesignAgentPageFollowMemory | null = null;
    expect(updateDesignAgentPageFollow(memory, input({ pages: [pageA, pageB] })).switchToPageId).toBeUndefined();
    memory = updateDesignAgentPageFollow(memory, input({ turnActive: true, pages: [pageA, pageB] })).memory;
    expect(updateDesignAgentPageFollow(memory, input({ turnActive: true, pages: [pageA, pageB] })).switchToPageId).toBeUndefined();
  });

  it("does not switch after the user navigates pages during that turn", () => {
    let memory: DesignAgentPageFollowMemory | null = null;
    memory = updateDesignAgentPageFollow(memory, input()).memory;
    memory = updateDesignAgentPageFollow(memory, input({ turnActive: true })).memory;
    memory = updateDesignAgentPageFollow(memory, input({ turnActive: true, navigationEvent: 1, activePageId: "page_a" })).memory;
    expect(updateDesignAgentPageFollow(memory, input({ turnActive: true, navigationEvent: 1, activePageId: "page_a", pages: [pageA, pageB] })).switchToPageId).toBeUndefined();
  });

  it("resets its baseline when hidden, inactive, or bound to another directory", () => {
    let memory: DesignAgentPageFollowMemory | null = null;
    memory = updateDesignAgentPageFollow(memory, input()).memory;
    memory = updateDesignAgentPageFollow(memory, input({ turnActive: true })).memory;
    memory = updateDesignAgentPageFollow(memory, input({ active: false, turnActive: true })).memory;
    memory = updateDesignAgentPageFollow(memory, input({ turnActive: true })).memory;
    expect(updateDesignAgentPageFollow(memory, input({ turnActive: true, pages: [pageA, pageB] })).switchToPageId).toBe("page_b");

    memory = updateDesignAgentPageFollow(memory, input({ directoryId: "other", turnActive: true, pages: [pageB] })).memory;
    expect(updateDesignAgentPageFollow(memory, input({ turnActive: true, pages: [pageA, pageB, pageC] })).switchToPageId).toBeUndefined();
  });
});

describe("Design page user navigation event", () => {
  it("counts only explicit user page navigation", () => {
    resetDesignWorkspaceUiForTests();
    bindDesignWorkspacePages("workspace", "design", [pageA, pageB]);
    const store = useDesignWorkspaceUiStore.getState();
    expect(designWorkspaceView("workspace").pageNavigationEvent ?? 0).toBe(0);
    store.setActivePage("workspace", "page_b", "design");
    expect(designWorkspaceView("workspace").pageNavigationEvent ?? 0).toBe(0);
    store.setActivePage("workspace", "page_a", "design", { user: true });
    expect(designWorkspaceView("workspace").pageNavigationEvent).toBe(1);
    resetDesignWorkspaceUiForTests();
  });
});
