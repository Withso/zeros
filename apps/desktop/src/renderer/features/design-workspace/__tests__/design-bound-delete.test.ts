// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ snapshots: new Map<string, unknown>(), listeners: new Set<() => void>() }));
vi.mock("../state/design-workspace-cache", () => ({
  applyDesignEditCached: vi.fn(),
  designWorkspaceSnapshotCache: {
    peekSnapshot: (id: string) => ({ data: mocks.snapshots.get(id) }),
    subscribe: (_id: string, listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
  },
}));
vi.mock("../state/design-selection", () => ({ selectDesignNodes: vi.fn(), selectDesignFrame: vi.fn() }));
import { DesignBoundDeleteDialog, useDesignBoundDelete } from "../design-bound-delete-dialog";
import { captureDesignPendingDeletion } from "../state/design-node-actions";
import { resetDesignWorkspaceUiForTests, useDesignWorkspaceUiStore } from "../state/design-workspace-ui";

const frame = { file: "a.html", sourceVersion: "a".repeat(24), title: "A", x: 0, y: 0, width: 200, height: 100, z: 0, nodeCount: 2, modifiedAt: 1 };
let root: Root;
let host: HTMLDivElement;
let api: ReturnType<typeof useDesignBoundDelete>;
const deleted: unknown[] = [];

function Canvas({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  api = useDesignBoundDelete(workspaceId, active);
  return createElement(DesignBoundDeleteDialog, {
    controls: api.controls, onCancel: api.cancel, onDelete: () => api.confirm((pending) => deleted.push(pending)),
  });
}
const render = (props: { workspaceId: string; active: boolean }) => act(async () => root.render(createElement(Canvas, props)));
const dialog = () => document.querySelector("[data-design-bound-delete]");

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetDesignWorkspaceUiForTests();
  mocks.snapshots.clear();
  mocks.snapshots.set("local", { frames: [frame] });
  useDesignWorkspaceUiStore.getState().setSelection("local", frame.file, "btn-label");
  deleted.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("closes the question when its canvas stops being the active surface, and a late confirm deletes nothing", async () => {
  await render({ workspaceId: "local", active: true });
  const pending = captureDesignPendingDeletion("local")!;
  await act(async () => api.ask(["Label"], pending));
  expect(dialog()).not.toBeNull();
  const lateConfirm = api.confirm;
  // A workspace switch keeps this canvas mounted, retained and inactive, with its own id.
  await render({ workspaceId: "local", active: false });
  await vi.waitFor(() => expect(dialog()).toBeNull());
  await act(async () => lateConfirm((late) => deleted.push(late)));
  expect(api.confirmable(pending)).toBeNull();
  expect(deleted).toEqual([]);
});

it("confirms on the active surface while its selection stands, and not after it changed", async () => {
  await render({ workspaceId: "local", active: true });
  await act(async () => api.ask(["Label"], captureDesignPendingDeletion("local")!));
  const remove = [...document.querySelectorAll<HTMLButtonElement>("[data-design-bound-delete] button")].find((button) => button.textContent === "Delete")!;
  await act(async () => remove.click());
  expect(deleted).toHaveLength(1);
  await act(async () => api.ask(["Label"], captureDesignPendingDeletion("local")!));
  await act(async () => useDesignWorkspaceUiStore.getState().setSelection("local", frame.file, "btn-icon-start"));
  await vi.waitFor(() => expect(dialog()).toBeNull());
  expect(deleted).toHaveLength(1);
});
