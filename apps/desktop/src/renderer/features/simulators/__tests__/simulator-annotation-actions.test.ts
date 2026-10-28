import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulatorAnnotationSnapshot } from "@zeros/protocol/simulator-captures";

type WorkbenchState = {
  workbenchByScope: Record<string, { tabs: { id: string; type: string }[] }>;
};

const api = vi.hoisted(() => ({
  loadSimulatorAnnotationSnapshot:
    vi.fn<(deviceId: string) => Promise<SimulatorAnnotationSnapshot>>(),
}));
const toasts = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
const delivery = vi.hoisted(() => ({ deliverFilesToChat: vi.fn() }));
const focus = vi.hoisted(() => ({ version: 0 }));
const painter = vi.hoisted(() => ({
  readAnnotationPalette: vi.fn(() => ({ color: {}, contrast: "white" })),
  renderAnnotatedScreen: vi.fn<() => Promise<Blob>>(),
}));
const workspace = vi.hoisted(() => {
  const listeners = new Set<(state: WorkbenchState, previous: WorkbenchState) => void>();
  return {
    listeners,
    useWorkspaceStore: {
      subscribe(listener: (state: WorkbenchState, previous: WorkbenchState) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
});

vi.mock("../simulator-api", () => api);
vi.mock("../../../shared/ui/primitives/elements", () => ({ toast: toasts }));
vi.mock("../../agent/composer-file-attachment-delivery", () => delivery);
vi.mock("../../../shared/ui/focus-navigation", () => ({ getFocusInteractionVersion: () => focus.version }));
vi.mock("../simulator-annotation-painter", () => painter);
vi.mock("../../../state/workspace-store", () => ({
  useWorkspaceStore: workspace.useWorkspaceStore,
}));

import {
  addAnnotationToChat,
  annotateFromTab,
  followSimulatorAnnotationTabs,
  leaveSimulatorAnnotation,
} from "../simulator-annotation-actions";
import type { AnnotationMark } from "../simulator-annotation-model";
import { simulatorAnnotations } from "../simulator-annotation-store";

const PHONE = { id: "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108", name: "iPhone 17" };
const TAB = "simulator-tab-1";
const CHAT = "chat-1";

const SNAPSHOT: SimulatorAnnotationSnapshot = {
  png: new Uint8Array([137, 80, 78, 71]),
  widthPx: 1206,
  heightPx: 2622,
  width: 402,
  height: 874,
  orientation: "portrait",
  deviceName: PHONE.name,
  osLabel: "iOS 26.0",
  appName: "Settings",
  appId: "com.apple.Preferences",
  elements: [
    {
      type: "Button",
      label: "Sign in",
      value: null,
      identifier: null,
      frame: { x: 150, y: 600, width: 100, height: 44 },
    },
  ],
};

const BOX: AnnotationMark = {
  kind: "rectangle",
  color: "red",
  note: "Make this bigger",
  from: { x: 140, y: 590 },
  to: { x: 260, y: 654 },
};

const themed = {} as HTMLElement;

async function annotated(marks: AnnotationMark[] = [BOX]) {
  await expect(annotateFromTab(TAB, PHONE)).resolves.toBe(true);
  for (const mark of marks) simulatorAnnotations.commit(TAB, (list) => [...list, mark]);
}

beforeEach(() => {
  simulatorAnnotations.reset();
  for (const mock of Object.values(toasts)) mock.mockReset();
  delivery.deliverFilesToChat.mockReset();
  focus.version = 0;
  painter.renderAnnotatedScreen.mockReset();
  painter.renderAnnotatedScreen.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  api.loadSimulatorAnnotationSnapshot.mockReset();
  api.loadSimulatorAnnotationSnapshot.mockResolvedValue(SNAPSHOT);
  workspace.listeners.clear();
});

describe("Annotate", () => {
  it("freezes the device's screen in the tab", async () => {
    await annotated([]);
    expect(api.loadSimulatorAnnotationSnapshot).toHaveBeenCalledWith(PHONE.id);
    expect(simulatorAnnotations.get(TAB)?.snapshot).toBe(SNAPSHOT);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("says why the screen couldn't be captured, in main's words", async () => {
    api.loadSimulatorAnnotationSnapshot.mockRejectedValue(new Error("iPhone 17 isn't running."));
    await expect(annotateFromTab(TAB, PHONE)).resolves.toBe(false);
    expect(toasts.error).toHaveBeenCalledWith("iPhone 17 isn't running.", {
      id: `simulator-annotate:${PHONE.id}`,
    });
    expect(simulatorAnnotations.get(TAB)).toBeNull();
  });

  it("asks before leaving marks behind", async () => {
    await annotated();
    const then = vi.fn();
    leaveSimulatorAnnotation(TAB, then);
    expect(simulatorAnnotations.leaveRequest()).toMatchObject({ tabId: TAB, marks: 1 });
    expect(then).not.toHaveBeenCalled();
    simulatorAnnotations.confirmLeave();
    expect(then).toHaveBeenCalledTimes(1);
    expect(simulatorAnnotations.get(TAB)).toBeNull();
  });
});

describe("Add to chat", () => {
  it.each([false, true])("preserves annotation delivery but revokes focus after newer input: %s", async (interrupted) => {
    await annotated();
    let finish!: (blob: Blob) => void;
    painter.renderAnnotatedScreen.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const adding = addAnnotationToChat(TAB, CHAT, themed);
    expect(simulatorAnnotations.get(TAB)?.adding).toBe(true);
    if (interrupted) focus.version++;
    finish(new Blob(["png"], { type: "image/png" }));
    await expect(adding).resolves.toBe(true);
    expect(delivery.deliverFilesToChat).toHaveBeenCalledTimes(1);
    const [chatId, sent, options] = delivery.deliverFilesToChat.mock.calls[0]!;
    expect(chatId).toBe(CHAT);
    expect(sent.files).toHaveLength(2);
    expect(options?.focus ?? true).toBe(!interrupted);
  });

  it("sends the annotated screen and its marks file to the chat, then ends", async () => {
    await annotated();
    await expect(addAnnotationToChat(TAB, CHAT, themed)).resolves.toBe(true);
    expect(painter.renderAnnotatedScreen).toHaveBeenCalledWith(SNAPSHOT, [BOX], {
      color: {},
      contrast: "white",
    });
    expect(delivery.deliverFilesToChat).toHaveBeenCalledTimes(1);
    const [chatId, delivered] = delivery.deliverFilesToChat.mock.calls[0]!;
    expect(chatId).toBe(CHAT);
    expect(delivered.id).toMatch(new RegExp(`^simulator-annotation:${TAB}:\\d+$`));
    const [image, marks] = delivered.files as File[];
    expect(image).toMatchObject({ type: "image/png" });
    expect(image!.name).toMatch(/^Simulator Annotation - iPhone 17 - .+\.png$/);
    expect(marks).toMatchObject({ type: "text/plain" });
    expect(marks!.name).toBe(image!.name.replace(/\.png$/, " marks.txt"));
    const text = await marks!.text();
    expect(text).toContain(`Annotated screenshot: ${image!.name}`);
    expect(text).toContain("Note: Make this bigger");
    expect(text).toContain('Button "Sign in"');
    expect(simulatorAnnotations.get(TAB)).toBeNull();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("keeps the marks when there is no chat to add them to", async () => {
    await annotated();
    await expect(addAnnotationToChat(TAB, null, themed)).resolves.toBe(false);
    expect(toasts.error).toHaveBeenCalledWith("No chat to add this to.", {
      description: "Open or create a chat first.",
    });
    expect(delivery.deliverFilesToChat).not.toHaveBeenCalled();
    expect(simulatorAnnotations.get(TAB)?.history.marks).toEqual([BOX]);
  });

  it("keeps the marks, and says so, when the image couldn't be drawn", async () => {
    await annotated();
    painter.renderAnnotatedScreen.mockRejectedValue(new Error("No canvas."));
    await expect(addAnnotationToChat(TAB, CHAT, themed)).resolves.toBe(false);
    expect(toasts.error).toHaveBeenCalledWith("No canvas.", {
      id: `simulator-annotate:${PHONE.id}`,
    });
    expect(simulatorAnnotations.get(TAB)).toMatchObject({ adding: false, history: { marks: [BOX] } });
  });

  it("holds the marks still while the image is drawn", async () => {
    await annotated();
    let finish!: (blob: Blob) => void;
    painter.renderAnnotatedScreen.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const adding = addAnnotationToChat(TAB, CHAT, themed);
    expect(simulatorAnnotations.get(TAB)?.adding).toBe(true);
    simulatorAnnotations.clear(TAB);
    expect(simulatorAnnotations.get(TAB)?.history.marks).toEqual([BOX]);
    await expect(addAnnotationToChat(TAB, CHAT, themed)).resolves.toBe(false);
    finish(new Blob(["png"], { type: "image/png" }));
    await expect(adding).resolves.toBe(true);
    expect(delivery.deliverFilesToChat).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the tab closed while the image was drawn", async () => {
    await annotated();
    let finish!: (blob: Blob) => void;
    painter.renderAnnotatedScreen.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const adding = addAnnotationToChat(TAB, CHAT, themed);
    simulatorAnnotations.prune(new Set());
    finish(new Blob(["png"], { type: "image/png" }));
    await expect(adding).resolves.toBe(false);
    expect(delivery.deliverFilesToChat).not.toHaveBeenCalled();
  });
});

describe("closing Simulator tabs", () => {
  it("ends the annotations of tabs that close in any workspace", async () => {
    await annotated();
    const stop = followSimulatorAnnotationTabs();
    const open: WorkbenchState = {
      workbenchByScope: { "/repo": { tabs: [{ id: TAB, type: "simulator" }] } },
    };
    const closed: WorkbenchState = { workbenchByScope: { "/repo": { tabs: [] } } };
    for (const listener of workspace.listeners) listener(open, closed);
    expect(simulatorAnnotations.get(TAB)).not.toBeNull();
    for (const listener of workspace.listeners) listener(closed, open);
    expect(simulatorAnnotations.get(TAB)).toBeNull();
    stop();
    expect(workspace.listeners.size).toBe(0);
  });
});
