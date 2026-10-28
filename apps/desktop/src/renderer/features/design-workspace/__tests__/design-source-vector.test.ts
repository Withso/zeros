import { describe, expect, it, vi } from "vitest";
import { DesignSourceLoadSlots, DesignSourceVectorBudget } from "../design-source-vector";

describe("source layout admission", () => {
  it("keeps temporary HTML documents bounded through a 256-frame cold open", async () => {
    const slots = new DesignSourceLoadSlots(8);
    const started: number[] = [];
    const tickets = Array.from({ length: 256 }, (_, index) => slots.request(() => { started.push(index); }));
    expect(started).toHaveLength(8);
    expect(slots.usage()).toEqual({ active: 8, waiting: 248 });
    for (let index = 0; index < tickets.length; index++) {
      expect(started).toContain(index);
      tickets[index]!.release(); tickets[index]!.release();
      // DOM cleanup must finish before a successor may allocate its iframe.
      expect(slots.usage().active).toBeLessThanOrEqual(8);
      await Promise.resolve();
    }
    expect(started).toHaveLength(256);
    expect(slots.usage()).toEqual({ active: 0, waiting: 0 });
  });

  it("cancels hidden queued work and never admits it after another owner returns capacity", async () => {
    const slots = new DesignSourceLoadSlots(1);
    const first = slots.request(vi.fn());
    const startHidden = vi.fn(); const hidden = slots.request(startHidden);
    hidden.release(); first.release();
    await Promise.resolve();
    expect(startHidden).not.toHaveBeenCalled();
    expect(slots.usage()).toEqual({ active: 0, waiting: 0 });
  });
});

describe("retained vector source bytes", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Frame</text></svg>';
  it("preserves Unicode in a self-contained image URL and charges the validated source", () => {
    const source = svg.replace("Frame", "Français 界 🖌️");
    const budget = new DesignSourceVectorBudget();
    const vector = budget.acquire(source)!;
    expect(vector.url).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(vector.url.split(",")[1]!, "base64").toString("utf8")).toBe(source);
    expect(vector.bytes).toBe(Buffer.byteLength(source));
    vector.release();
    expect(budget.usage()).toEqual({ entries: 0, bytes: 0 });
  });
  it("accounts outgoing and incoming source until their actual image references detach", () => {
    const create = vi.fn(() => "blob:fixture"); const revoke = vi.fn();
    const budget = new DesignSourceVectorBudget(svg.length * 2, { create, revoke });
    const a = budget.acquire(svg)!; const b = budget.acquire(svg)!;
    expect(a).not.toBeNull(); expect(b).not.toBeNull();
    expect(budget.acquire(svg)).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
    a.release(); a.release();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(budget.usage()).toEqual({ entries: 1, bytes: svg.length });
    b.release();
    expect(budget.usage()).toEqual({ entries: 0, bytes: 0 });
  });

  it("charges UTF-8 bytes and refuses non-SVG or oversized message data before allocating a URL", () => {
    const create = vi.fn(); const revoke = vi.fn();
    const budget = new DesignSourceVectorBudget(128, { create, revoke });
    expect(budget.acquire(svg.replace("Frame", "界".repeat(30)))).toBeNull();
    expect(budget.acquire("<html>not a vector surface</html>")).toBeNull();
    expect(budget.acquire("<svg " + "x".repeat(2 * 1024 * 1024))).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not charge capacity when URL allocation fails", () => {
    const budget = new DesignSourceVectorBudget(1024, { create: () => { throw new Error("decoder unavailable"); }, revoke: vi.fn() });
    expect(() => budget.acquire(svg)).toThrow("decoder unavailable");
    expect(budget.usage()).toEqual({ entries: 0, bytes: 0 });
  });
});
