import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { ComposerConcealedContext, ModelPill } from "../composer-pills";
import * as catalog from "../model-catalog";

const menu = vi.hoisted(() => ({ open: (_open: boolean) => {} }));
vi.mock("../agent-model-menu", () => ({ AgentModelMenu: (props: { onOpenChange(open: boolean): void; children: ReactNode }) => {
  menu.open = props.onOpenChange;
  return props.children;
} }));

describe("cloud model menu revalidation", () => {
  it.each(["inactive", "concealed"])("does not start discovery from an %s composer", mode => {
    const refresh = vi.fn();
    renderToStaticMarkup(createElement(ComposerConcealedContext.Provider, { value: mode === "concealed" },
      createElement(ModelPill, { agentId: "codex", initialize: null, value: "gpt-6-luna", effort: "low", fast: false,
        active: mode !== "inactive", onChange: vi.fn(), onConfigure: vi.fn(), onRefreshModels: refresh })));
    menu.open(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["cloud", "Local Personal", "organization-local"])("builds the Codex group with the right account list while a Claude chat is selected (%s)", placement => {
    const file = new URL("../agent-model-menu.tsx", import.meta.url);
    const ast = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback = "";
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "groups" && node.initializer && ts.isCallExpression(node.initializer))
        callback = node.initializer.arguments[0].getText(ast);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    const initialize = { protocolVersion: 1, _meta: placement === "cloud"
      ? { cloudModelScope: "cloud/workspace/1", modelsDynamic: true, cloudCodexModels: [{ value: "gpt-6-luna", label: "Luna" }] }
      : { modelsAccountScoped: true, models: [{ value: "claude-haiku-5-5", label: "Haiku" }] } };
    const run = vm.runInNewContext(ts.transpileModule(`(${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      ...catalog, initialize, value: { agentId: "claude" }, isEnabled: () => true, isSelectableAgent: () => true,
      registry: [{ id: "codex" }, { id: "claude" }], hasSavedDefault: false, FAMILY_ORDER: { claude: 0, codex: 1, cursor: 2 },
    }) as () => Array<{ agent: { id: string }; models: Array<{ value: string; selectable?: boolean }> }>;
    const sol = run().find(group => group.agent.id === "codex")?.models.find(model => model.value === "gpt-6.1-sol");
    expect(sol).toBeDefined();
    expect(sol?.selectable === false).toBe(placement === "cloud");
  });

  it("requests fresh cached metadata when opened, without waiting or refreshing on close", () => {
    const refresh = vi.fn();
    renderToStaticMarkup(createElement(ModelPill, { agentId: "codex", initialize: null,
      value: "gpt-6-luna", effort: "low", fast: false, onChange: vi.fn(), onConfigure: vi.fn(), onRefreshModels: refresh }));
    expect(refresh).not.toHaveBeenCalled();
    menu.open(true);
    expect(refresh).toHaveBeenCalledOnce();
    menu.open(false);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(["/personal/repo", "/organization/repo", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"])("only wires menu discovery for the cloud placement: %s", folder => {
    const file = new URL("../agent-chat.tsx", import.meta.url);
    const ast = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let expression: string | undefined;
    function visit(node: ts.Node) {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "ModelPill") {
        const prop = node.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === "onRefreshModels");
        if (prop && ts.isJsxAttribute(prop) && prop.initializer && ts.isJsxExpression(prop.initializer)) expression = prop.initializer.expression?.getText(ast);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    const refresh = vi.fn();
    const callback = expression && vm.runInNewContext(expression, { isCloudWorkspace, chatThread: { folder }, session: { refreshModelCatalog: refresh } });
    expect(callback).toBe(isCloudWorkspace(folder) ? refresh : undefined);
  });
});
