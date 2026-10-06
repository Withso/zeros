import { describe, expect, it, vi } from "vitest";
import { CloudSendPreparation, type CloudSendOwner } from "../cloud-send-preparation";

const owner: CloudSendOwner = {
  account: 1, generation: 7, cancellation: 0,
  folder: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe("cloud message preparation", () => {
  it("does not open compute after a send is cancelled in the same turn", async () => {
    const preparation = new CloudSendPreparation(), open = vi.fn(async () => {});
    const pending = preparation.prepare("chat", owner, open, () => owner);
    preparation.cancel("chat");
    await expect(pending).rejects.toThrow(/cancel/);
    expect(open).not.toHaveBeenCalled();
  });
  it("shares preparation without admitting or submitting a prompt twice", async () => {
    const preparation = new CloudSendPreparation(), wake = deferred();
    const open = vi.fn(() => wake.promise), submit = vi.fn();
    const draft = { text: "inspect this", attachments: ["fixture-image"] };
    const first = preparation.prepare("chat", owner, open, () => owner);
    expect(preparation.prepare("chat", owner, open, () => owner)).toBe(first);
    const sending = first.then(() => submit(draft));
    expect(submit).not.toHaveBeenCalled();
    expect(draft.attachments).toEqual(["fixture-image"]);
    wake.resolve(); await sending;
    expect(open).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledExactlyOnceWith(draft);
    expect(preparation.has("chat")).toBe(false);
  });

  it.each(["account", "folder", "generation", "cancellation"] as const)("does not submit after its %s owner changes", async field => {
    const preparation = new CloudSendPreparation(), wake = deferred(), submit = vi.fn();
    let current = owner;
    const sending = preparation.prepare("chat", owner, () => wake.promise, () => current).then(submit);
    const rejected = expect(sending).rejects.toThrow(/owner changed/);
    current = { ...owner, [field]: field === "folder" ? `${owner.folder}-other` : field === "generation" ? 6 : 99 };
    wake.resolve(); await rejected;
    expect(submit).not.toHaveBeenCalled();
  });
  it("shares a pending wake across a forward replacement while retaining its original chat/account owner", async () => {
    const preparation = new CloudSendPreparation(), wake = deferred(), open = vi.fn(() => wake.promise);
    let current = owner;
    const first = preparation.prepare("chat", owner, open, () => current);
    await Promise.resolve(); current = { ...owner, generation: 8 };
    expect(preparation.prepare("chat", current, open, () => current)).toBe(first);
    wake.resolve(); await first; expect(open).toHaveBeenCalledOnce();
  });

  it("cancels only the original chat and keeps a replacement intent after a late completion", async () => {
    const preparation = new CloudSendPreparation(), old = deferred(), next = deferred(), other = deferred();
    const open = vi.fn((_signal: AbortSignal) => old.promise), submit = vi.fn();
    const first = preparation.prepare("chat", owner, open, () => owner).then(submit);
    const rejected = expect(first).rejects.toThrow(/cancel/);
    const sibling = preparation.prepare("other", owner, () => other.promise, () => owner);
    await Promise.resolve();
    preparation.cancel("chat");
    expect(open.mock.calls[0][0].aborted).toBe(true);
    const replacement = preparation.prepare("chat", owner, () => next.promise, () => owner);
    old.resolve(); await rejected;
    expect(preparation.has("chat")).toBe(true);
    expect(preparation.has("other")).toBe(true);
    next.resolve(); other.resolve(); await Promise.all([replacement, sibling]);
    expect(submit).not.toHaveBeenCalled();
  });
});
