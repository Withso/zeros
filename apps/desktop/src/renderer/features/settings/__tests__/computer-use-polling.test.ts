import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as activity from "../../../shared/lib/element-activity";

const ast = ts.createSourceFile("computer-use-panel.tsx", readFileSync(new URL("../computer-use-panel.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" &&
      node.arguments[1]?.getText(ast) === "[refreshStatus, surfaceActive]") callback = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
if (!callback) throw new Error("Local computer status polling effect missing");
const code = ts.transpileModule(`globalThis.dispose = (${callback})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let focused: boolean;
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); focused = true;
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  vi.stubGlobal("document", page); vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  dispose?.(); dispose = undefined;
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.unstubAllGlobals();
});
function mount(surfaceActive = true) {
  const refreshStatus = vi.fn();
  const context = { ...activity, surfaceActive, refreshStatus, window, document, setInterval, clearInterval,
    dispose: undefined as (() => void) | undefined };
  vm.runInNewContext(code, context); dispose = context.dispose;
  return refreshStatus;
}

describe("Local computer permissions observation", () => {
  it.each(["hidden", "blurred", "retained"])("owns no native reads or timers while %s", mode => {
    if (mode === "hidden") page.visibilityState = "hidden";
    if (mode === "blurred") focused = false;
    const read = mount(mode !== "retained"); vi.advanceTimersByTime(60_000);
    console.info(JSON.stringify({ mode, elapsedMs: 60_000, reads: read.mock.calls.length, timers: vi.getTimerCount() }));
    expect(read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes immediately on reveal and owns only one visible interval", () => {
    const read = mount(); expect(read).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10_000); expect(read).toHaveBeenCalledTimes(3);
    focused = false; window.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(60_000); expect(read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    focused = true; window.dispatchEvent(new Event("focus"));
    expect(read).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(1);
    dispose?.(); dispose = undefined; window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(60_000); expect(read).toHaveBeenCalledTimes(4);
  });
});
