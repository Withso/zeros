import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Run the actual callback's final await/ownership transaction without mounting
// the provider tree. Two flights may settle to the same value and still have
// different owners; awaiting the comparison would discard that distinction.
const source = readFileSync(new URL("../sessions-provider.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("provider.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbackNames = ["ensureSession", "refreshProviderCapabilities"] as const;
type CallbackName = (typeof callbackNames)[number];
type WorkResult = void | boolean;

function settlementCode(name: CallbackName): string {
  let declaration: ts.VariableDeclaration | undefined;
  function collect(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) declaration = node;
    ts.forEachChild(node, collect);
  }
  collect(ast);
  if (!declaration?.initializer || !ts.isCallExpression(declaration.initializer)) throw new Error(`Missing callback ${name}`);
  const callback = declaration.initializer.arguments[0];
  if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) throw new Error(`Invalid callback ${name}`);
  const statement = callback.body.statements.find(node => ts.isTryStatement(node) &&
    node.tryBlock.statements.some(child => child.getText(ast) === (name === "ensureSession" ? "await work;" : "return await work;")));
  if (!statement) throw new Error(`Missing awaited settlement ${name}`);
  return ts.transpileModule(`globalThis.settle = async function(work) { ${statement.getText(ast)} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

function deferred() {
  let resolve!: (value: WorkResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<WorkResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(code: string) {
  const flights = new Map<string, Promise<WorkResult>>();
  const patchSession = vi.fn();
  const evictUnretainedTranscripts = vi.fn();
  let activePatch = patchSession;
  const context = {
    chatId: "chat", bindWasSuperseded: true,
    ensureInFlightRef: { current: flights }, capabilityRefreshInFlightRef: { current: flights },
    getStore: () => ({ patchSession: activePatch }), evictUnretainedTranscripts,
    settle: undefined as unknown as (work: Promise<WorkResult>) => Promise<WorkResult>,
  };
  vm.runInNewContext(code, context);
  return { flights, patchSession, evictUnretainedTranscripts, settle: context.settle,
    switchOwner: (patch: typeof patchSession) => { activePatch = patch; } };
}

describe.each(callbackNames)("%s flight ownership", name => {
  const code = settlementCode(name);
  const result = name === "ensureSession" ? undefined : true;

  it("awaits unfinished work before publishing or clearing the original flight", async () => {
    const h = harness(code), work = deferred();
    h.flights.set("chat", work.promise);
    const settlement = h.settle(work.promise);
    await Promise.resolve();
    expect(h.flights.get("chat")).toBe(work.promise);
    expect(h.patchSession).not.toHaveBeenCalled();
    work.resolve(result);
    await expect(settlement).resolves.toBe(result);
    expect(h.flights.has("chat")).toBe(false);
    if (name === "ensureSession") expect(h.patchSession).toHaveBeenCalledWith("chat", { status: "reconnecting", error: null, failure: null });
  });

  it("retains a replacement even when both flights resolve to the same value", async () => {
    const h = harness(code), old = deferred(), replacement = Promise.resolve(result);
    h.flights.set("chat", old.promise);
    const settlement = h.settle(old.promise);
    h.flights.set("chat", replacement);
    old.resolve(result);
    await settlement;
    expect(await replacement).toBe(result);
    expect(h.flights.get("chat")).toBe(replacement);
    expect(h.patchSession).not.toHaveBeenCalled();
  });

  it("cannot patch or clear a new owner's flight after Local/cloud placement switching", async () => {
    const h = harness(code), old = deferred(), replacement = Promise.resolve(result);
    h.flights.set("chat", old.promise);
    const settlement = h.settle(old.promise);
    const newOwnerPatch = vi.fn();
    h.switchOwner(newOwnerPatch);
    h.flights.set("chat", replacement);
    h.flights.set("other-chat", replacement);
    old.resolve(result);
    await settlement;
    expect(h.flights.get("chat")).toBe(replacement);
    expect(h.flights.get("other-chat")).toBe(replacement);
    expect(h.patchSession).not.toHaveBeenCalled();
    expect(newOwnerPatch).not.toHaveBeenCalled();
  });

  it("clears the original rejected flight while preserving its rejection for the caller", async () => {
    const h = harness(code), work = deferred(), error = new Error("original flight failed");
    h.flights.set("chat", work.promise);
    const settlement = h.settle(work.promise);
    const rejected = expect(settlement).rejects.toBe(error);
    work.reject(error);
    await rejected;
    expect(h.flights.has("chat")).toBe(false);
    expect(h.patchSession).not.toHaveBeenCalled();
  });

  it("retains the replacement when an older flight rejects", async () => {
    const h = harness(code), old = deferred(), replacement = Promise.resolve(result);
    h.flights.set("chat", old.promise);
    const settlement = h.settle(old.promise);
    const rejected = expect(settlement).rejects.toThrow("old flight failed");
    h.flights.set("chat", replacement);
    old.reject(new Error("old flight failed"));
    await rejected;
    expect(h.flights.get("chat")).toBe(replacement);
    expect(h.patchSession).not.toHaveBeenCalled();
  });
});
