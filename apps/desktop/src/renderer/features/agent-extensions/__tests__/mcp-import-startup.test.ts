import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("../mcp-import-dialog.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("mcp-import-dialog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let scan = "";
(function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" &&
      node.arguments[0]?.getText(ast).includes("bridgeMcpScanNative(")) scan = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
})(ast);
function harness(status: string, bridge: object | null) {
  const context = {
    open: true, active: true, bridge, bridgeStatus: status, connected: status === "connected" && bridge !== null,
    sources: null, projects: [{ repoRoot: "/personal/repo" }, { repoRoot: "/organization/repo" }], existingNames: new Set(),
    setLoading: vi.fn(), setScanError: vi.fn(), setSources: vi.fn(), setSelected: vi.fn(), setComposedNames: vi.fn(),
    bridgeMcpScanNative: vi.fn(async () => []), bridgeMcpResolveComposed: vi.fn(async () => []), keyOf: (a: string, b: string) => `${a}:${b}`,
  };
  const run = vm.runInNewContext(ts.transpileModule(`(${scan})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context) as () => void | (() => void);
  return { ...context, run };
}
it.each([null, { status: "connecting" }])("waits for the Local engine without a false MCP scan error: %j", bridge => {
  const f = harness("connecting", bridge);
  f.run();
  expect(f.setScanError.mock.calls.every(([error]) => error === null)).toBe(true);
  expect(f.bridgeMcpScanNative).not.toHaveBeenCalled();
  expect(f.setLoading).toHaveBeenCalledWith(true);
});
it("retires scan replies when the import dialog is closed", async () => {
  const f = harness("connected", { status: "connected" });
  const cleanup = f.run();
  cleanup?.();
  f.setSources.mockClear(); f.setSelected.mockClear();
  await Promise.resolve(); await Promise.resolve();
  expect(f.setSources).not.toHaveBeenCalled();
  expect(f.setSelected).not.toHaveBeenCalled();
  expect(f.bridgeMcpScanNative).toHaveBeenCalledWith(expect.anything(), ["/personal/repo", "/organization/repo"]);
});

it.each(["loading", "missing", "failed", "malformed"])("does not replace MCP settings while their read is %s", async state => {
  let handler = "";
  (function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "handleImport")
      handler = node.initializer!.getText(ast);
    ts.forEachChild(node, visit);
  })(ast);
  const write = vi.fn(async () => {});
  const context = {
    sources: [{ source: "cursor", servers: [{ name: "example" }] }],
    connected: true, scanError: null, loading: false, busy: false,
    layer: state === "missing" ? null : { doc: {}, error: state === "malformed" ? "Invalid TOML" : undefined },
    settingsLoading: state === "loading", settingsReadError: state === "failed" ? "Read failed" : null,
    setBusy: vi.fn(), existingNames: new Set(), existing: [],
    selected: new Set(["cursor:example"]), keyOf: (a: string, b: string) => `${a}:${b}`,
    importToSettings: async () => ({ entry: { name: "example" } }),
    write, bridge: {}, toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() }, onClose: vi.fn(),
  };
  const run = vm.runInNewContext(ts.transpileModule(`(${handler})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context) as () => Promise<void>;
  await run();
  expect(write).not.toHaveBeenCalled();
  expect(context.setBusy).not.toHaveBeenCalled();
});
