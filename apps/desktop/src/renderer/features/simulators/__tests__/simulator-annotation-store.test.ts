import { describe, expect, it, vi } from "vitest";
import type { SimulatorAnnotationSnapshot } from "@zeros/protocol/simulator-captures";

vi.mock("../simulator-api", () => ({ loadSimulatorAnnotationSnapshot: vi.fn() }));

import { MAX_ANNOTATION_MARKS, type AnnotationMark } from "../simulator-annotation-model";
import { SimulatorAnnotations, openSimulatorTabIds } from "../simulator-annotation-store";

const PHONE = { id: "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108", name: "iPhone 17" };
const TAB = "simulator-tab-1";
const OTHER_TAB = "simulator-tab-2";

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
  elements: [],
};

const mark = (x: number, note = ""): AnnotationMark => ({
  kind: "rectangle",
  color: "red",
  note,
  from: { x, y: 10 },
  to: { x: x + 40, y: 50 },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Load = (deviceId: string) => Promise<SimulatorAnnotationSnapshot>;

function annotations(load = vi.fn<Load>(async () => SNAPSHOT)) {
  return { store: new SimulatorAnnotations({ load, now: () => 1_000 }), load };
}

async function frozen(marks: AnnotationMark[] = []) {
  const { store, load } = annotations();
  await store.begin(TAB, PHONE);
  for (const entry of marks) store.commit(TAB, (list) => [...list, entry]);
  return { store, load };
}

describe("freezing the screen", () => {
  it("captures the device's screen while the tab waits, then holds it", async () => {
    const capture = deferred<SimulatorAnnotationSnapshot>();
    const { store, load } = annotations(vi.fn(() => capture.promise));
    const begun = store.begin(TAB, PHONE);
    expect(load).toHaveBeenCalledWith(PHONE.id);
    expect(store.get(TAB)).toMatchObject({
      tabId: TAB,
      deviceId: PHONE.id,
      deviceName: PHONE.name,
      snapshot: null,
      frozenAt: 1_000,
      tool: "pen",
      color: "red",
      adding: false,
    });
    capture.resolve(SNAPSHOT);
    await expect(begun).resolves.toMatchObject({ snapshot: SNAPSHOT });
    expect(store.get(TAB)?.snapshot).toBe(SNAPSHOT);
    expect(store.get(OTHER_TAB)).toBeNull();
  });

  it("keeps a tab's annotation when Annotate is pressed again", async () => {
    const { store, load } = await frozen([mark(10)]);
    await expect(store.begin(TAB, PHONE)).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.get(TAB)?.history.marks).toHaveLength(1);
  });

  it("ends the annotation when the screen can't be captured", async () => {
    const { store } = annotations(vi.fn(async () => Promise.reject(new Error("Not running."))));
    await expect(store.begin(TAB, PHONE)).rejects.toThrow("Not running.");
    expect(store.get(TAB)).toBeNull();
    expect(store.any()).toBe(false);
  });

  it("drops a capture that arrives after its annotation ended", async () => {
    const first = deferred<SimulatorAnnotationSnapshot>();
    const second = deferred<SimulatorAnnotationSnapshot>();
    const load = vi
      .fn<Load>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { store } = annotations(load);
    const late = store.begin(TAB, PHONE);
    store.end(TAB);
    const current = store.begin(TAB, PHONE);
    const later = { ...SNAPSHOT, appName: "Maps" };
    second.resolve(later);
    await expect(current).resolves.toMatchObject({ snapshot: later });
    first.resolve(SNAPSHOT);
    await expect(late).resolves.toBeNull();
    expect(store.get(TAB)?.snapshot).toBe(later);
  });

  it("starts with the tool and color the last annotation used", async () => {
    const { store } = await frozen();
    store.setTool(TAB, "arrow");
    store.setColor(TAB, "blue");
    store.end(TAB);
    await store.begin(OTHER_TAB, PHONE);
    expect(store.get(OTHER_TAB)).toMatchObject({ tool: "arrow", color: "blue" });
  });

  it("tells listeners only about changes", async () => {
    const { store } = await frozen();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.setTool(TAB, "pen");
    store.undo(TAB);
    expect(listener).not.toHaveBeenCalled();
    store.setTool(TAB, "line");
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    store.setTool(TAB, "text");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("marks and their history", () => {
  it("undoes, redoes and clears marks, one step at a time", async () => {
    const first = mark(10);
    const second = mark(100);
    const { store } = await frozen([first, second]);
    const marks = () => store.get(TAB)?.history.marks;
    expect(marks()).toEqual([first, second]);
    store.undo(TAB);
    expect(marks()).toEqual([first]);
    store.redo(TAB);
    expect(marks()).toEqual([first, second]);
    store.clear(TAB);
    expect(marks()).toEqual([]);
    store.undo(TAB);
    expect(marks()).toEqual([first, second]);
  });

  it("takes back a shape and its note with one undo", async () => {
    const shape = mark(10);
    const { store } = await frozen([shape]);
    store.amend(TAB, (list) => list.map((entry) => ({ ...entry, note: "Too small" })));
    expect(store.get(TAB)?.history.marks[0]?.note).toBe("Too small");
    store.undo(TAB);
    expect(store.get(TAB)?.history.marks).toEqual([]);
  });

  it(`holds up to ${MAX_ANNOTATION_MARKS} marks`, async () => {
    const full = Array.from({ length: MAX_ANNOTATION_MARKS }, (_, index) => mark(index));
    const { store } = await frozen();
    store.commit(TAB, () => full);
    store.commit(TAB, (list) => [...list, mark(500)]);
    expect(store.get(TAB)?.history.marks).toHaveLength(MAX_ANNOTATION_MARKS);
  });

  it("waits for the screen to freeze, and for Add to chat to finish", async () => {
    const capture = deferred<SimulatorAnnotationSnapshot>();
    const { store } = annotations(vi.fn(() => capture.promise));
    const begun = store.begin(TAB, PHONE);
    store.commit(TAB, (list) => [...list, mark(10)]);
    expect(store.get(TAB)?.history.marks).toEqual([]);
    capture.resolve(SNAPSHOT);
    await begun;

    const serial = store.get(TAB)!.serial;
    store.setAdding(TAB, serial, true);
    store.commit(TAB, (list) => [...list, mark(10)]);
    store.clear(TAB);
    expect(store.get(TAB)?.history.marks).toEqual([]);
    store.setAdding(TAB, serial + 1, false);
    expect(store.get(TAB)?.adding).toBe(true);
    store.setAdding(TAB, serial, false);
    store.commit(TAB, (list) => [...list, mark(10)]);
    expect(store.get(TAB)?.history.marks).toHaveLength(1);
  });
});

describe("leaving an annotation", () => {
  it("leaves at once when there are no marks to lose", async () => {
    const { store } = await frozen();
    const then = vi.fn();
    expect(store.leave(TAB, then)).toBe("left");
    expect(store.get(TAB)).toBeNull();
    expect(then).toHaveBeenCalledTimes(1);
    expect(store.leaveRequest()).toBeNull();
  });

  it("runs what leaving was for when the tab has no annotation", () => {
    const { store } = annotations();
    const then = vi.fn();
    expect(store.leave(TAB, then)).toBe("left");
    expect(then).toHaveBeenCalledTimes(1);
  });

  it("asks before discarding marks, and keeps them when the user cancels", async () => {
    const { store } = await frozen([mark(10), mark(100)]);
    const then = vi.fn();
    expect(store.leave(TAB, then)).toBe("asking");
    expect(store.leaveRequest()).toMatchObject({ tabId: TAB, deviceName: PHONE.name, marks: 2 });
    expect(store.get(TAB)?.history.marks).toHaveLength(2);
    store.cancelLeave();
    expect(store.leaveRequest()).toBeNull();
    expect(store.get(TAB)?.history.marks).toHaveLength(2);
    expect(then).not.toHaveBeenCalled();
  });

  it("discards the marks, then does what leaving was for", async () => {
    const { store } = await frozen([mark(10)]);
    const order: string[] = [];
    store.subscribe(() => order.push(store.get(TAB) ? "annotating" : "ended"));
    store.leave(TAB, () => order.push("closed"));
    store.confirmLeave();
    expect(store.get(TAB)).toBeNull();
    expect(store.leaveRequest()).toBeNull();
    expect(order).toEqual(["annotating", "ended", "closed"]);
  });

  it("ends the annotations of tabs that closed, and stops asking about them", async () => {
    const { store } = await frozen([mark(10)]);
    await store.begin(OTHER_TAB, PHONE);
    store.leave(TAB, vi.fn());
    store.prune(new Set([OTHER_TAB]));
    expect(store.get(TAB)).toBeNull();
    expect(store.get(OTHER_TAB)).not.toBeNull();
    expect(store.leaveRequest()).toBeNull();
  });
});

describe("open Simulator tabs", () => {
  it("lists Simulator tabs in every workspace", () => {
    expect(
      openSimulatorTabIds({
        "/repo": {
          tabs: [
            { id: "changes", type: "changes" },
            { id: TAB, type: "simulator" },
          ],
        },
        "/other": { tabs: [{ id: OTHER_TAB, type: "simulator" }] },
      }),
    ).toEqual(new Set([TAB, OTHER_TAB]));
  });
});
