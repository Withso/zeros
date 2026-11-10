import { describe, expect, it, vi } from "vitest";
import { handleCopyPathKey } from "../copy-path-shortcut";

const key = (over: Partial<Parameters<typeof handleCopyPathKey>[0]> = {}) => ({
  code: "KeyC", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, ...over,
});

describe("the workspace Command-C shortcut", () => {
  it("copies the path only if no other listener used the key, whatever order they registered in", () => {
    // Listeners on window run in registration order. The Design canvas, which
    // copies the selected layer, registered after this one and lost the key.
    const pending: Array<() => void> = [];
    const copy = vi.fn();
    const env = { active: true, editable: false, textSelected: false, defer: (work: () => void) => { pending.push(work); }, copy };
    const taken = key();
    handleCopyPathKey(taken, env);
    expect(copy).not.toHaveBeenCalled();
    // A later listener takes the key for its own selection.
    taken.defaultPrevented = true;
    pending.splice(0).forEach((work) => work());
    expect(copy).not.toHaveBeenCalled();

    handleCopyPathKey(key(), env);
    pending.splice(0).forEach((work) => work());
    expect(copy).toHaveBeenCalledOnce();
  });

  it("leaves a real copy alone: text selected, a typing surface, another chord or another page", () => {
    const defer = vi.fn();
    const env = { active: true, editable: false, textSelected: false, defer, copy: vi.fn() };
    handleCopyPathKey(key(), { ...env, textSelected: true });
    handleCopyPathKey(key(), { ...env, editable: true });
    handleCopyPathKey(key(), { ...env, active: false });
    handleCopyPathKey(key({ shiftKey: true }), env);
    handleCopyPathKey(key({ code: "KeyV" }), env);
    handleCopyPathKey(key({ defaultPrevented: true }), env);
    expect(defer).not.toHaveBeenCalled();
  });
});
