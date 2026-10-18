import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as refreshRules from "../pr-status-refresh";
import { isCloudWorkspace, parseCloudScopedId } from "../../../platform/bridge/cloud-workspace-key";
import { documentIsForeground } from "../../../shared/lib/element-activity";

vi.mock("react", () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
import { useDocumentActive } from "../../../state/use-document-active";

// Execute the real passive effects and their owner gate; actions and visual
// derivation are covered separately. Keeping imported helpers real preserves
// terminal-state, age, execution and cancellation semantics in this harness.
const source = ts.createSourceFile("pr-status-island.tsx", readFileSync(new URL("../pr-status-island.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects: string[] = [], declarations: string[] = [];
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && ["livePr", "rememberIslandData"].includes(node.name?.text ?? "")) declarations.push(node.getText(source));
  if (ts.isVariableDeclaration(node) && ["local", "foreground", "observing", "ISLAND_FRESH_MS", "MAX_PR_ISLAND_SNAPSHOTS"].includes(node.name.getText(source)))
    declarations.push(`const ${node.getText(source)};`);
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") {
    const body = node.arguments[0]?.getText(source) ?? "";
    if (["classifyPrStatusEffectTrigger", "requestExternalRefresh", "checkingRetryRef.current.tries"].some(marker => body.includes(marker))) effects.push(body);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (effects.length !== 3) throw new Error("PR island passive effect coverage changed");
const code = ts.transpileModule(`${declarations.join("\n")}\nglobalThis.disposers = [${effects.map(effect => `(${effect})()`).join(",")}].filter(Boolean);`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let page: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let focused: boolean;
const cleanups: Array<() => void> = [];
function unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000); focused = true;
  page = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  vi.stubGlobal("document", page); vi.stubGlobal("window", Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval }));
});
afterEach(() => { unmount(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); });
function mount(path = "/personal/project", id = "personal-workspace", rawKind = "ready", cache = new Map()) {
  const reads = [vi.fn(async () => null), vi.fn(async () => null), vi.fn(async () => ({ number: 42, state: "ready" })), vi.fn(async () => null)];
  const setLive = vi.fn();
  const context = {
    ...refreshRules, useDocumentActive, documentIsForeground, isCloudWorkspace, parseCloudScopedId,
    document, window, Date, Promise,
    workspace: { id, path, repoRoot: path, prState: "ready", repoSlug: "repo", prNumber: 42 },
    active: true, localDesktop: true, prNumber: 42, dataKey: `${id}#42`, refreshKey: 1, forceRefreshAt: 0,
    activationKeyRef: { current: null }, lastRequestAtRef: { current: 0 }, lastKnownData: cache,
    statusForGeneration: reads[0], changeCountsForGeneration: reads[1], ghPrGet: reads[2], ghPrChecks: reads[3],
    ghPrSync: vi.fn(), notifyWorkspacesChanged: vi.fn(), setLive, setForceRefreshAt: vi.fn(),
    checkingRetryRef: { current: { key: "", tries: 0 } }, stabilityKey: id, rawKind,
    disposers: [] as Array<() => void>,
  };
  vm.runInNewContext(code, context); cleanups.push(...context.disposers);
  return { reads, setLive, cache };
}

describe("Local PR island activity", () => {
  it.each([
    ["/personal/project", "hidden"], ["/personal/project", "blurred"],
    ["/organization/project", "hidden"], ["/organization/project", "blurred"],
  ])("starts no native reads or timers for %s while %s", async (path, mode) => {
    if (mode === "hidden") page.visibilityState = "hidden";
    else focused = false;
    const { reads } = mount(path); await vi.advanceTimersByTimeAsync(60_000);
    console.info(JSON.stringify({ mode, path, nativeReads: reads.reduce((n, read) => n + read.mock.calls.length, 0), timers: vi.getTimerCount() }));
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains confirmed data during blur and stops the checking retry", async () => {
    const first = mount(); await vi.advanceTimersByTimeAsync(0); unmount();
    const confirmed = first.cache.get("personal-workspace#42");
    focused = false;
    const hidden = mount(undefined, undefined, "checking", first.cache);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hidden.cache.get("personal-workspace#42")).toBe(confirmed);
    expect(hidden.setLive).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["hidden", "blurred"])("preserves native cloud scheduling while %s", async mode => {
    if (mode === "hidden") page.visibilityState = "hidden";
    else focused = false;
    const { reads } = mount("/physical/checkout", "cloud://organization/workspace");
    await vi.advanceTimersByTimeAsync(60_000);
    for (const read of reads) expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
  });
});
