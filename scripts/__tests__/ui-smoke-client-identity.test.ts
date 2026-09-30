import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const folderFixture =
  "apps/desktop/src/renderer/harnesses/harness-folder-workspace.tsx";
const titleFixture = "scripts/ui-smoke-chat-titles.mjs";

function nativeFixtureBridge(file: string) {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JS,
  );
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "__ZEROS_NATIVE__"
    )
      initializer = node.initializer;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(source) === "window.__ZEROS_NATIVE__"
    )
      initializer = node.right;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!initializer) throw new Error(`Native fixture missing in ${file}`);
  const compiled = ts.transpileModule(`(${initializer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return runInNewContext(compiled.outputText, {
    requests: [],
    cloudEnabled: true,
  }) as NonNullable<Window["__ZEROS_NATIVE__"]>;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", {
    __ZEROS_NATIVE__: nativeFixtureBridge(folderFixture),
  });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ configured: true })));
});
afterEach(() => vi.unstubAllGlobals());

describe("UI smoke control-plane client identity", () => {
  it.each([
    {
      name: "cloud Create",
      file: folderFixture,
      url: "https://api.example.test/v1/organizations/11111111-1111-4111-8111-111111111111/cloud-workspaces/create-options",
    },
    {
      name: "chat titles",
      file: titleFixture,
      url: "https://api.example.test/v1/chat-titles",
    },
  ])("tags user requests from the $name native fixture", async ({ file, url }) => {
    vi.stubGlobal("window", { __ZEROS_NATIVE__: nativeFixtureBridge(file) });
    const { controlPlaneFetch } = await import(
      "../../apps/desktop/src/renderer/features/update/control-plane-fetch"
    );
    const beforeRequest = vi.fn();
    const response = await controlPlaneFetch(url, undefined, beforeRequest);

    expect(await response.json()).toEqual({ configured: true });
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("X-Zeros-Client"),
    ).toBe("desktop/dev/0.1.0");
    expect(await window.__ZEROS_NATIVE__!.invoke("app_info")).toMatchObject({
      runtimeMode: "dev",
      channel: "alpha",
      version: "0.1.0",
      platform: "darwin",
      arch: "arm64",
    });
  });

  it("still blocks on a 426 when the native smoke fixture sends a request", async () => {
    const required = { minimumVersion: "1.2.3", latestVersion: "1.2.4" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "client_upgrade_required", ...required } },
          { status: 426 },
        ),
      ),
    );
    const { controlPlaneFetch } = await import(
      "../../apps/desktop/src/renderer/features/update/control-plane-fetch"
    );
    const { useRequiredUpdateStore } = await import(
      "../../apps/desktop/src/renderer/features/update/required-update-state"
    );

    expect(
      (await controlPlaneFetch("https://api.example.test/v1/me")).status,
    ).toBe(426);
    expect(useRequiredUpdateStore.getState().required).toEqual(required);
  });

  it("tags a browser without a native bridge as dev without invoking IPC", async () => {
    vi.stubGlobal("window", {});
    const { controlPlaneFetch } = await import(
      "../../apps/desktop/src/renderer/features/update/control-plane-fetch"
    );

    await controlPlaneFetch("https://api.example.test/v1/me");

    expect(
      new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("X-Zeros-Client"),
    ).toBe("desktop/dev/unknown");
  });

  it("allows the client identity header in the chat-title CORS fixture", () => {
    const source = readFileSync(
      new URL(`../../${titleFixture}`, import.meta.url),
      "utf8",
    );
    const allowHeaders = source
      .match(/"access-control-allow-headers":\s*"([^"]+)"/)?.[1]
      .split(",")
      .map((header) => header.trim().toLowerCase());

    expect(allowHeaders).toContain("x-zeros-client");
  });
});
