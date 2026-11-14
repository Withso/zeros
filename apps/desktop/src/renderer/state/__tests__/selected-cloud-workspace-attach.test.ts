import { describe, expect, it, vi } from "vitest";
import { attachSelectedCloudWorkspace } from "../selected-cloud-workspace-attach";

type Doc = { status: string; deletedAt: null | string; generation?: { number: number } | null; sharing?: { readOnly?: boolean } | null };
function fixture(initial: Doc | undefined) {
  let doc = initial, hidden = false;
  const listeners = new Set<() => void>(), visibility = new Set<() => void>();
  const warmHistory = vi.fn(async () => {}), connect = vi.fn(async () => {});
  const stop = attachSelectedCloudWorkspace({
    document: () => doc as never, hidden: () => hidden, warmHistory, connect,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    onVisibility: listener => { visibility.add(listener); return () => visibility.delete(listener); },
    connected: vi.fn(), failed: vi.fn(),
  });
  return {
    warmHistory, connect, stop,
    set(next: Doc | undefined) { doc = next; for (const listener of [...listeners]) listener(); },
    notify() { for (const listener of [...listeners]) listener(); },
    show(value: boolean) { hidden = !value; for (const listener of [...visibility]) listener(); },
  };
}
const stopped: Doc = { status: "stopped", deletedAt: null, generation: { number: 1 } };

// Launch census F: every catalog notify (list refreshes, other workspaces' documents) re-read the selected
// workspace's chats.list. Only a change to what this workspace serves history from reads again.
describe("selected cloud workspace attach", () => {
  it("reads history once per serving state, not on every catalog notify", async () => {
    const f = fixture(stopped);
    expect(f.warmHistory).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 9; i++) f.notify();
    f.set({ ...stopped });
    expect(f.warmHistory).toHaveBeenCalledTimes(1);
    expect(f.connect).not.toHaveBeenCalled();
    // Starting → ready changes where history comes from: read once. Keeping the connection attached stays as before
    // (a connected peer costs nothing; a dropped one reattaches).
    f.set({ ...stopped, status: "ready" });
    expect(f.warmHistory).toHaveBeenCalledTimes(2);
    expect(f.connect).toHaveBeenCalledTimes(1);
    await Promise.resolve(); await Promise.resolve();
    f.notify(); f.set({ ...stopped, status: "busy" });
    expect(f.warmHistory).toHaveBeenCalledTimes(2);
    // A new generation or a sharing downgrade is a different serving state.
    f.set({ ...stopped, status: "busy", generation: { number: 2 } });
    f.set({ ...stopped, status: "busy", generation: { number: 2 }, sharing: { readOnly: true } });
    expect(f.warmHistory).toHaveBeenCalledTimes(4);
    f.stop();
  });

  it("returning to a visible window reads again; a hidden window and an unreadable document do not", async () => {
    const f = fixture(stopped);
    f.show(false); f.notify();
    f.show(true);
    expect(f.warmHistory).toHaveBeenCalledTimes(2);
    f.set({ ...stopped, status: "deleting" }); f.set(undefined);
    expect(f.warmHistory).toHaveBeenCalledTimes(2);
    f.set(stopped);
    expect(f.warmHistory).toHaveBeenCalledTimes(3);
    f.stop(); f.notify();
    expect(f.warmHistory).toHaveBeenCalledTimes(3);
  });

  it("a failed history read is retried on the next notify", async () => {
    const f = fixture(undefined);
    f.warmHistory.mockRejectedValueOnce(new Error("offline"));
    f.set(stopped);
    await Promise.resolve(); await Promise.resolve();
    f.notify(); f.notify();
    expect(f.warmHistory).toHaveBeenCalledTimes(2);
    f.stop();
  });
});
