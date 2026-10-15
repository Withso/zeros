import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkpointBottomSpacer } from "../checkpoint-rail";

const ast = ts.createSourceFile("checkpoint-rail.tsx", readFileSync(new URL("../checkpoint-rail.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "scrollToCheckpoint" && node.initializer && ts.isCallExpression(node.initializer))
    callback = node.initializer.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
if (!callback) throw new Error("Real checkpoint navigation callback missing");
const code = ts.transpileModule(`globalThis.jump = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
afterEach(() => vi.useRealTimers());

function fixture({ start = 0, target = 10_000, height = 12_000 } = {}) {
  vi.useFakeTimers();
  const writes: number[] = [], calls: ScrollToOptions[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let top = start;
  const scrollEl = {
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = value; writes.push(value); },
    scrollHeight: height, clientHeight: 600,
    scrollTo(options: ScrollToOptions) {
      calls.push(options);
      // A native smooth scroll does not synchronously arrive at its target.
      if (options.behavior !== "smooth") this.scrollTop = options.top ?? top;
    },
    addEventListener(name: string, fn: () => void) {
      const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set);
    },
    removeEventListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn); },
  };
  const bottomSpacerRef = { current: 0 }, pinnedIdRef = { current: null as string | null };
  const navigatingRef = { current: false }, cancelSettleRef = { current: vi.fn() as () => void };
  const positions = new Map([['target', target], ['next', target / 2]]);
  const targetTopFor = (id: string) => positions.get(id) ?? null;
  const recompute = vi.fn(), setActiveIndex = vi.fn();
  const context = { scrollEl, cancelSettleRef, checkpointBottomSpacer, bottomSpacerRef, pinnedIdRef, navigatingRef,
    spacerForIdRef: { current: null as string | null }, targetTopFor, recompute, setActiveIndex,
    checkpointsRef: { current: [{ id: 'target' }, { id: 'next' }] },
    flushSync: (action: () => void) => action(), onBottomSpacerChange: (size: number) => {
      scrollEl.scrollHeight += size - bottomSpacerRef.current; bottomSpacerRef.current = size;
    }, beginChatScrollNavigation: vi.fn(), CHAT_SCROLL_NAVIGATION_EVENT: "navigation",
    window: { setTimeout, clearTimeout }, jump: undefined as ((id: string) => void) | undefined };
  vm.runInNewContext(code, context);
  return { jump: context.jump!, scrollEl, calls, writes, positions, pinnedIdRef, navigatingRef, recompute, bottomSpacerRef,
    emit(name: string) { for (const listener of [...listeners.get(name) ?? []]) listener(); } };
}

describe("instant checkpoint navigation", () => {
  it.each([350, 520_000, 2_600_000])("jumps directly to %i without traversing or animating intermediate history", target => {
    const f = fixture({ target, height: target + 1200 });
    f.jump("target");
    expect(f.scrollEl.scrollTop).toBe(target);
    expect(f.writes).toEqual([target]);
    expect(f.calls.every(call => call.behavior === "auto")).toBe(true);
    expect(f.pinnedIdRef.current).toBe("target");
  });

  it("makes a short final answer reachable before its immediate jump", () => {
    const f = fixture({ start: 4000, target: 9500, height: 9600 });
    f.jump("target");
    expect(f.bottomSpacerRef.current).toBe(500);
    expect(f.scrollEl.scrollTop).toBe(9500);
    expect(f.scrollEl.scrollHeight - f.scrollEl.clientHeight).toBe(9500);
  });

  it("corrects an estimate without animating and keeps the selected checkpoint pinned", () => {
    const f = fixture(); f.jump("target");
    f.positions.set("target", 10_100); f.emit("scrollend");
    expect(f.scrollEl.scrollTop).toBe(10_100);
    expect(f.calls.every(call => call.behavior === "auto")).toBe(true);
    expect(f.pinnedIdRef.current).toBe("target");
  });

  it.each(["wheel", "pointerdown", "navigation"])("does not correct after %s cancels navigation", event => {
    const f = fixture(); f.jump("target");
    f.emit(event); f.positions.set("target", 10_100);
    const before = f.calls.length; vi.runAllTimers(); f.emit("scrollend");
    expect(f.calls).toHaveLength(before);
    expect(f.navigatingRef.current).toBe(false);
  });

  it("retires a previous checkpoint settle before a newer jump", () => {
    const f = fixture(); f.jump("target"); f.jump("next");
    f.positions.set("target", 10_100); vi.runAllTimers();
    expect(f.pinnedIdRef.current).toBe("next");
    expect(f.scrollEl.scrollTop).toBe(5000);
    expect(f.calls.every(call => call.behavior === "auto")).toBe(true);
  });

  it("leaves the viewport intact when the requested row has no current geometry", () => {
    const f = fixture({ start: 2000 }); f.jump("unloaded");
    expect(f.calls).toEqual([]); expect(f.scrollEl.scrollTop).toBe(2000);
    expect(f.pinnedIdRef.current).toBeNull();
  });
});
