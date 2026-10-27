import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { useReadRecovery } from "../use-read-recovery";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));
const source = readFileSync(new URL("../use-projects.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("use-projects.ts", source, ts.ScriptTarget.Latest, true);
const hook = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useArchivedWorkspaces")!.getText(ast).replace(/^export /, "");
it("does not expose a transient archived-workspace read error to Dashboard or repository lists", () => {
  const snapshot = { data: undefined, error: new Error("temporary archive read"), loading: false, refreshing: false };
  const useArchives = vm.runInNewContext(ts.transpileModule(`${hook}; useArchivedWorkspaces;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    ...React, useReadRecovery, useBridgeStatus: () => "connected",
    EMPTY_WORKSPACES: [], workspaceCollectionCache: { getSnapshot: () => snapshot, subscribe: () => () => {} },
  }) as () => { error: Error | null };
  let error: Error | null = null;
  function Probe() { error = useArchives().error; return null; }
  renderToStaticMarkup(React.createElement(Probe));
  expect(error).toBeNull();
});
