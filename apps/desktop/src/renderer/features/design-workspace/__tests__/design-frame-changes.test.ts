import { beforeEach, describe, expect, it, vi } from "vitest";

import { DESIGN_RUNTIME_FRAME_CHANGE_LIMITS, type DesignRuntimeFrameChanges } from "@zeros/protocol/design-runtime";

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), wait: vi.fn() }));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.runtime, waitForDesignFrameRuntime: mocks.wait }));

import { useSessionsStore } from "../../agent/sessions-store";
import {
  designFrameChangeList,
  designFrameChangesSummary,
  designTidyOutcome,
  dismissDesignTidy,
  readDesignFrameChanges,
  readDesignTidyOutcome,
  resetDesignFrameChangesForTests,
  startDesignTidy,
  useDesignFrameChangesStore,
  useDesignTidyStore,
} from "../state/design-frame-changes";

const V1 = "1".repeat(24);
const V2 = "2".repeat(24);
const btn = { origin: "frame" as const, selector: ".btn", subjectClasses: ["btn"] };

function frame(layers: DesignRuntimeFrameChanges["layers"], extra: Partial<DesignRuntimeFrameChanges> = {}): DesignRuntimeFrameChanges {
  return { sourceVersion: V1, examined: layers.length, truncated: false, layers, ...extra };
}
const change = (property: string, value: string, replaced = "6px") => ({ property, value, replaced: { ...btn, value: replaced } });

const SIGN_IN = frame([
  { oid: "send", name: "Send", changes: [change("border-radius", "8px"), change("border-top-left-radius", "9px"), change("background-color", "black", "var(--bg1)")] },
  { oid: "card", name: "Card", changes: [change("row-gap", "12px", "8px")] },
]);

describe("changes made by hand, as the panel names them", () => {
  it("counts one per field on each layer, a shorthand's sides once", () => {
    const list = designFrameChangeList(SIGN_IN);
    expect(list.map((entry) => `${entry.oid}:${entry.field}`)).toEqual(["send:Corner radius", "send:Fill", "card:Gap"]);
    expect(designFrameChangesSummary(list, false)).toEqual({
      title: "3 changes made by hand",
      body: "Corner radius, Fill and Gap, on 2 layers.",
    });
  });

  it("says one change and one layer in the singular, and nothing at all for none", () => {
    const one = designFrameChangeList(frame([{ oid: "card", name: "Card", changes: [change("gap", "4px", "2px")] }]));
    expect(designFrameChangesSummary(one, false)).toEqual({ title: "1 change made by hand", body: "Gap, on 1 layer." });
    expect(designFrameChangesSummary([], false)).toBeNull();
  });

  it("says when only some layers were looked at", () => {
    const list = designFrameChangeList(SIGN_IN);
    expect(designFrameChangesSummary(list, true)?.body).toBe("Corner radius, Fill and Gap, on 2 layers. Not every layer was checked, so there may be more.");
  });
});

describe("what Tidy did", () => {
  const before = designFrameChangeList(SIGN_IN);

  it("counts values now on a token, from their source, or still on their layer", () => {
    // The radius now reads a token on the layer; the fill moved off it into
    // its class's token; the gap stays.
    const after = designFrameChangeList(frame([
      { oid: "send", name: "Send", changes: [change("border-radius", "var(--radius-md)")] },
      { oid: "card", name: "Card", changes: [change("row-gap", "12px", "8px")] },
    ]));
    const follow = [{ oid: "send", property: "background-color", own: false, value: "var(--bg2)" }];
    expect(designTidyOutcome(before, after, follow)).toBe("2 now use tokens, 1 stays on its layer. Nothing is committed.");
  });

  it("names a value that moved into its class or component without a token", () => {
    const follow = [
      { oid: "send", property: "border-radius", own: false, value: "6px" },
      { oid: "send", property: "background-color", own: false, value: "black" },
      { oid: "card", property: "row-gap", own: false, value: "12px" },
    ];
    expect(designTidyOutcome(before, [], follow)).toBe("3 now come from their class or component. Nothing is committed.");
  });

  it("does not say a value whose layer is gone stays on it", () => {
    // The agent deleted Card: its gap is neither in the changes nor followed.
    const after = designFrameChangeList(frame([{ oid: "send", name: "Send", changes: [change("border-radius", "8px"), change("background-color", "black", "var(--bg1)")] }]));
    expect(designTidyOutcome(before, after, [])).toBe("1 is no longer on its layer, 2 stay on their layer. Nothing is committed.");
  });

  it("does not say values past what was followed stay on their layer", () => {
    // All three left their layer; only the radius was followed (the rest past
    // the follow limit).
    const follow = [{ oid: "send", property: "border-radius", own: false, value: "6px" }];
    expect(designTidyOutcome(before, [], follow)).toBe("1 now comes from its class or component, 2 are no longer on their layer. Nothing is committed.");
  });

  it("says when nothing moved", () => {
    expect(designTidyOutcome(before, before, [])).toBe("3 stay on their layer. Nothing is committed.");
  });
});

function fakeRuntime(sourceVersion = V1) {
  const replies: Array<(value: DesignRuntimeFrameChanges) => void> = [];
  const runtime = {
    sourceVersion,
    supports: vi.fn((method: string) => method === "getFrameChanges"),
    getFrameChanges: vi.fn(() => new Promise<DesignRuntimeFrameChanges>((resolve) => replies.push(resolve))),
  };
  return { runtime, replies };
}

const stored = () => useDesignFrameChangesStore.getState().byKey["w\u0000home.html"];

describe("the frame's changes, by exact key", () => {
  beforeEach(() => {
    resetDesignFrameChangesForTests();
    mocks.runtime.mockReset();
    mocks.wait.mockReset().mockResolvedValue(null);
  });

  it("reads once per generation and publishes only the reply for the frame's current generation", async () => {
    const { runtime, replies } = fakeRuntime();
    mocks.runtime.mockReturnValue(runtime);
    readDesignFrameChanges("w", "home.html", V1);
    readDesignFrameChanges("w", "home.html", V1);
    expect(runtime.getFrameChanges).toHaveBeenCalledTimes(1);
    replies[0]!(SIGN_IN);
    await vi.waitFor(() => expect(stored()?.sourceVersion).toBe(V1));
    expect(stored()?.changes).toHaveLength(3);

    // A newer generation is read; the last confirmed count stays meanwhile.
    runtime.sourceVersion = V2;
    readDesignFrameChanges("w", "home.html", V2);
    expect(stored()?.sourceVersion).toBe(V1);
    // A reply for a generation the frame has left is dropped.
    replies[1]!({ ...SIGN_IN, sourceVersion: V2 });
    runtime.sourceVersion = "3".repeat(24);
    await Promise.resolve();
    await Promise.resolve();
    expect(stored()?.sourceVersion).toBe(V1);
  });

  it("drops a reply from a document that was replaced", async () => {
    const first = fakeRuntime();
    const replacement = fakeRuntime();
    mocks.runtime.mockReturnValue(first.runtime);
    readDesignFrameChanges("w", "home.html", V1);
    mocks.runtime.mockReturnValue(replacement.runtime);
    first.replies[0]!(SIGN_IN);
    await Promise.resolve();
    await Promise.resolve();
    expect(stored()).toBeUndefined();
  });

  it("reads once the frame's document for that generation connects, when it was not ready yet", async () => {
    // A frame selection restored on open mounts the panel before the frame's
    // document has connected.
    const { runtime, replies } = fakeRuntime();
    let connect!: (value: unknown) => void;
    mocks.runtime.mockReturnValue(null);
    mocks.wait.mockReturnValue(new Promise((resolve) => (connect = resolve)));
    readDesignFrameChanges("w", "home.html", V1);
    expect(mocks.wait).toHaveBeenCalledWith("w", "home.html", expect.any(Number), expect.objectContaining({ sourceVersion: V1 }));
    mocks.runtime.mockReturnValue(runtime);
    connect(runtime);
    await vi.waitFor(() => expect(runtime.getFrameChanges).toHaveBeenCalledTimes(1));
    replies[0]!(SIGN_IN);
    await vi.waitFor(() => expect(stored()?.changes).toHaveLength(3));
  });

  it("stops waiting for the document once the panel is gone", async () => {
    const { runtime } = fakeRuntime();
    let connect!: (value: unknown) => void;
    mocks.runtime.mockReturnValue(null);
    mocks.wait.mockImplementation((_w, _f, _t, options: { signal?: AbortSignal }) => new Promise((resolve) => {
      connect = resolve;
      options.signal?.addEventListener("abort", () => resolve(null));
    }));
    const gone = new AbortController();
    readDesignFrameChanges("w", "home.html", V1, gone.signal);
    gone.abort();
    mocks.runtime.mockReturnValue(runtime);
    connect(runtime);
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.getFrameChanges).not.toHaveBeenCalled();
  });

  it("follows at most as many values as the runtime answers for", async () => {
    const { runtime, replies } = fakeRuntime();
    mocks.runtime.mockReturnValue(runtime);
    const before = Array.from({ length: 70 }, (_, index) => ({
      oid: `l${index}`, layer: `L${index}`, field: "Gap", property: "row-gap", value: "1px", replaced: { ...btn, value: "2px" },
    }));
    const outcome = readDesignTidyOutcome("w", "home.html", V1, before, []);
    const asked = (runtime.getFrameChanges.mock.calls[0] as unknown as [{ oid: string }[]])[0];
    expect(asked).toHaveLength(DESIGN_RUNTIME_FRAME_CHANGE_LIMITS.follow);
    replies[0]!({ ...frame([]), follow: asked.map((entry) => ({ ...entry, property: "row-gap", own: false, value: "2px" })) });
    await expect(outcome).resolves.toBe("64 now come from their class or component, 6 are no longer on their layer. Nothing is committed.");
  });

  it("asks nothing of a runtime that cannot answer, or of another generation", () => {
    const { runtime } = fakeRuntime();
    runtime.supports.mockReturnValue(false);
    mocks.runtime.mockReturnValue(runtime);
    readDesignFrameChanges("w", "home.html", V1);
    const stale = fakeRuntime(V2);
    mocks.runtime.mockReturnValue(stale.runtime);
    readDesignFrameChanges("w", "home.html", V1);
    expect(runtime.getFrameChanges).not.toHaveBeenCalled();
    expect(stale.runtime.getFrameChanges).not.toHaveBeenCalled();
  });
});

describe("a Tidy for one frame", () => {
  beforeEach(() => {
    resetDesignFrameChangesForTests();
    useSessionsStore.setState({ sessions: {} });
  });
  const tidy = () => useDesignTidyStore.getState().byKey["w\u0000home.html"];
  const status = (chatId: string, value: "streaming" | "idle") =>
    useSessionsStore.setState((state) => ({ sessions: { ...state.sessions, [chatId]: { ...(state.sessions[chatId] ?? {}), status: value } as never } }));

  it("runs from the click, follows its chat's turn, and ends when that turn ends", () => {
    let hooks: { onSent: (chatId: string) => void; onFailed: () => void } | null = null;
    startDesignTidy({ workspaceId: "w", frame: "home.html", before: designFrameChangeList(SIGN_IN), ask: (given) => { hooks = given; } });
    expect(tidy()).toMatchObject({ phase: "running", chatId: null });
    hooks!.onSent("chat-1");
    expect(tidy()).toMatchObject({ phase: "running", chatId: "chat-1" });
    // Another chat's turn says nothing about this one.
    status("chat-2", "streaming");
    status("chat-2", "idle");
    expect(tidy()?.phase).toBe("running");
    status("chat-1", "streaming");
    expect(tidy()?.phase).toBe("running");
    status("chat-1", "idle");
    expect(tidy()?.phase).toBe("ended");
    // Nothing listens once it ended.
    status("chat-1", "streaming");
    expect(tidy()?.phase).toBe("ended");
    dismissDesignTidy("w", "home.html");
    expect(tidy()).toBeUndefined();
  });

  it("goes back to the waiting count when the brief could not be sent", () => {
    startDesignTidy({ workspaceId: "w", frame: "home.html", before: [], ask: ({ onFailed }) => onFailed() });
    expect(tidy()).toBeUndefined();
  });
});
