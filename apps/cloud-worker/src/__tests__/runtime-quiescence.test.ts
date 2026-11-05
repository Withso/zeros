import { describe, expect, it } from "vitest";
import { RuntimeQuiescence, type RuntimeCensus } from "../runtime-quiescence";

const quiet = (): RuntimeCensus => ({ clients: false, requests: false, agents: false, terminals: false, setup: false,
  checkout: false, configuration: false, prompts: false, attachments: false, storage: false, tools: false });

describe("runtime update admission", () => {
  function fixture() {
    let now = 0;
    const census = quiet(), gate = new RuntimeQuiescence(() => census, () => now);
    return { census, gate, advance: (ms: number) => { now += ms; } };
  }
  it.each(Object.keys(quiet()) as Array<keyof RuntimeCensus>)("refuses %s throughout a continuous quiet dwell", kind => {
    const f = fixture();
    expect(f.gate.ticket()).toBeNull(); f.advance(29_999); expect(f.gate.ticket()).toBeNull();
    f.census[kind] = true; f.advance(1); expect(f.gate.ticket()).toBeNull();
    f.census[kind] = false; expect(f.gate.ticket()).toBeNull(); f.advance(30_000);
    expect(f.gate.ticket()).not.toBeNull();
  });
  it("unknown activity and a missed census category both refuse", () => {
    const f = fixture();
    f.census.storage = null; f.gate.ticket(); f.advance(60_000); expect(f.gate.ticket()).toBeNull();
    delete (f.census as Partial<RuntimeCensus>).storage;
    f.advance(60_000); expect(f.gate.ticket()).toBeNull();
  });
  it("even activity that has finished invalidates the preparation ticket", async () => {
    const f = fixture(); f.gate.ticket(); f.advance(30_000);
    const ticket = f.gate.ticket()!;
    const leave = await f.gate.admit(); leave();
    expect(f.gate.freeze(ticket)).toBe(false);
    f.advance(30_000); expect(f.gate.ticket()).not.toBeNull();
  });
  it("late foreground work cancels an uncommitted handoff and then runs", async () => {
    const f = fixture(); f.gate.ticket(); f.advance(30_000);
    const ticket = f.gate.ticket()!; expect(f.gate.freeze(ticket)).toBe(true);
    let entered = false;
    const admission = Promise.resolve(f.gate.admit()).then(leave => { entered = true; leave(); });
    await Promise.resolve(); expect(entered).toBe(false);
    expect(f.gate.commit(ticket)).toBe(false);
    f.gate.release(); await admission; expect(entered).toBe(true);
  });
  it("foreground work arriving after commit waits for the confirmed successor", async () => {
    const f = fixture(); f.gate.ticket(); f.advance(30_000);
    const ticket = f.gate.ticket()!;
    expect(f.gate.freeze(ticket)).toBe(true); expect(f.gate.commit(ticket)).toBe(true);
    let entered = false;
    const admission = Promise.resolve(f.gate.admit()).then(leave => { entered = true; leave(); });
    await Promise.resolve(); expect(entered).toBe(false);
    f.gate.release(); await admission; expect(entered).toBe(true);
  });
});
