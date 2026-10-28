import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { chromium, type Browser } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { browserDomMarkers } from "../../apps/desktop/electron/browser/surface";
import { classifyBrowserClick } from "../../apps/desktop/electron/browser/confirmations";

// Exercise the actual strings sent to Chromium without importing Electron.
const source = readFileSync("apps/desktop/electron/browser/service.ts", "utf8");
const ast = ts.createSourceFile("service.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["snapshotScript", "inspectClickScript", "prepareClickScript", "validateClickTargetScript", "focusForKeyScript", "SCROLL_INTO_VIEW_OPTIONS", "BROWSER_DOM_POLICY"]);
const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node) ? names.has(node.name?.text ?? "") :
  ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && names.has(d.name.text)));
const scripts = new Function(ts.transpileModule(selected.map(n => n.getText(ast)).join("\n") +
  '\nreturn { snapshotScript, inspectClickScript, prepareClickScript, validateClickTargetScript, focusForKeyScript };',
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)() as Record<string, (...args: any[]) => string>;
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

it("runs all Browser DOM consent and input scripts outside the page's JavaScript world", () => {
  const guarded = new Set(["snapshotScript", "inspectClickScript", "prepareClickScript", "validateClickTargetScript", "inspectInputScript", "typeScript", "focusForKeyScript"]);
  const unsafe: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "executeJavaScript" &&
      node.arguments[0] && ts.isCallExpression(node.arguments[0]) && guarded.has(node.arguments[0].expression.getText(ast))) unsafe.push(node.arguments[0].expression.getText(ast));
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(unsafe).toEqual([]);
});

it("redacts effective password types, verification codes and payment data without value-based labels", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<input type="PASSWORD" value="secret-password"><input autocomplete="one-time-code" value="123456"><input autocomplete="cc-number" value="4111111111111111">');
    const result = await page.evaluate(scripts.snapshotScript("data-test", "scope", "data-test"));
    for (const secret of ["secret-password", "123456", "4111111111111111"]) expect(JSON.stringify(result)).not.toContain(secret);
    const inspected = await page.evaluate(scripts.inspectClickScript("data-test", "b1_scope"));
    expect(JSON.stringify(inspected)).not.toContain("secret-password");
  } finally { await page.close(); }
});

it.each(["", 'type="invalid"', 'type="SuBmIt"'])("recognizes the effective form owner of a nested button (%s)", async type => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<form id="f" action="https://example.test/submit"></form><button form="f" ${type}><span data-test="b1">Continue</span></button>`);
    const action = await page.evaluate(scripts.inspectClickScript("data-test", "b1"));
    expect(action.submitsForm).toBe(true);
    expect(action.inputType).toBe("submit");
  } finally { await page.close(); }
});

it.each(["", 'type="invalid"', 'type="SuBmIt"'])("does not request submission approval for a button without a form owner (%s)", async type => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<button ${type}><span data-test="b1">Continue</span></button>`);
    const action = await page.evaluate(scripts.inspectClickScript("data-test", "b1"));
    expect(action.inputType).toBe("submit");
    expect(action.submitsForm).toBe(false);
    expect(classifyBrowserClick(action)).toBeNull();
    expect(classifyBrowserClick({ ...action, label: "Pay now" })).toBe("payment");
    expect(classifyBrowserClick({ ...action, submitsForm: undefined })).toBe("external-submit");
  } finally { await page.close(); }
});

it("rejects changed form and link destinations after approval and after hover", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<form id="f" action="https://example.test/first"><button data-test="b1">Continue</button></form>');
    const action = await page.evaluate(scripts.inspectClickScript("data-test", "b1"));
    await page.evaluate(() => { document.querySelector('form')!.action = 'https://example.test/changed'; });
    expect((await page.evaluate(scripts.prepareClickScript("data-test", "b1", action.actionKey ?? null))).ok).toBe(false);
    expect((await page.evaluate(scripts.validateClickTargetScript("data-test", "b1", action.actionKey ?? null, action.x, action.y))).ok).toBe(false);
  } finally { await page.close(); }
});

it("keeps real snapshot policy independent of page-authored DOM prototype overrides", async () => {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.setContent('<input type="password" value="password-canary"><form><button>Continue</button></form>');
    await page.evaluate(() => {
      Object.defineProperty(HTMLInputElement.prototype, "type", { get: () => "text" });
      Object.defineProperty(HTMLButtonElement.prototype, "type", { get: () => "button" });
    });
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "zeros-policy-test" });
    const extraNames = new Set(["snapshotResult", "executeBrowserDomScript", "AGENT_PAGE_WORLD_ID"]);
    const extra = ast.statements.filter(node => ts.isFunctionDeclaration(node) ? extraNames.has(node.name?.text ?? "") :
      ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && extraNames.has(d.name.text)));
    const snapshotResult = new Function("randomBytes", "browserDomMarkers", "success", "asRecord",
      ts.transpileModule([...selected, ...extra].map(n => n.getText(ast)).join("\n") + '\nreturn snapshotResult;',
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(randomBytes, browserDomMarkers, (value: unknown) => value, (value: unknown) => value);
    const result = await snapshotResult({ refAttribute: "data-test", consoleErrors: [], networkErrors: [], downloads: [], view: { webContents: {
      isLoading: () => false,
      executeJavaScript: (code: string) => page.evaluate(code),
      executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
        const evaluation = await cdp.send("Runtime.evaluate", { expression: scripts[0].code, contextId: executionContextId, returnByValue: true, awaitPromise: true });
        if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.text);
        return evaluation.result.value;
      },
    } } });
    expect(JSON.stringify(result)).not.toContain("password-canary");
    expect(result.elements[0].type).toBe("password");
    expect(result.elements[1].type).toBe("submit");
  } finally { await cdp.detach(); await page.close(); }
});
