import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDesignFrame,
  DESIGN_DIRECTORY_NAME,
  initializeDesignDocument,
  readDesignFrame,
  updateDesignNodeStyles,
} from "../document";
import { DesignMcpServer } from "../mcp-server";
import { forgetDesignSelection, setDesignSelection } from "../selection";
import {
  resetDesignScreenshotsForTests,
  setDesignScreenshot,
} from "../screenshots";
import type { Workspace } from "../../git/types";

describe("zeros-design MCP server", () => {
  let root: string;
  let server: DesignMcpServer;
  let workspace: Workspace;
  let client: Client | null;

  beforeEach(async () => {
    resetDesignScreenshotsForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-mcp-"));
    await initializeDesignDocument(root);
    await createDesignFrame(root, { title: "Checkout" });
    workspace = {
      id: "ws_design",
      kind: "design",
      repoSlug: "repo",
      repoRoot: root,
      branch: "zeros/design",
      baseBranch: "main",
      path: root,
      status: "in-progress",
      createdAt: 1,
      archivedAt: null,
      stashRef: null,
      prNumber: null,
      prState: null,
      prUrl: null,
      agentId: null,
      lastActiveAt: 1,
    };
    forgetDesignSelection(workspace.id);
    server = new DesignMcpServer({
      resolveWorkspace: (id) => (id === workspace.id ? workspace : null),
    });
    await server.start();
    client = null;
  });

  afterEach(async () => {
    await client?.close().catch(() => {});
    await server.stop();
    forgetDesignSelection(workspace.id);
    await rm(root, { recursive: true, force: true });
    resetDesignScreenshotsForTests();
  });

  async function connect(): Promise<Client> {
    const url = server.urlForWorkspace(workspace.id);
    expect(url).not.toBeNull();
    const next = new Client({ name: "test", version: "1" });
    await next.connect(new StreamableHTTPClientTransport(new URL(url!)));
    client = next;
    return next;
  }

  it("exposes the compact design read and structured-write toolset", async () => {
    const connected = await connect();
    const tools = await connected.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "get_selection",
      "list_frames",
      "get_frame",
      "screenshot_frame",
      "lint_design",
      "get_tokens",
      "get_guide",
      "write_html",
      "update_styles",
      "set_text",
    ]);
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "get_selection",
      "list_frames",
      "get_frame",
      "screenshot_frame",
      "lint_design",
      "get_tokens",
      "get_guide",
    ]) {
      expect(byName.get(name)?.annotations, name).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    for (const name of ["write_html", "update_styles", "set_text"]) {
      expect(byName.get(name)?.annotations, name).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
    expect(connected.getInstructions()).toContain("pure HTML and CSS");
    expect(connected.getInstructions()).toContain(
      "never put data-oid on html, head, body",
    );
    expect(
      connected.getInstructions()?.match(/call lint_design/g) ?? [],
    ).toHaveLength(2);
  });

  it("scopes frame, selection, lint, token, and guide reads to the workspace", async () => {
    const currentFrame = await readDesignFrame(root, "checkout.html");
    setDesignSelection(workspace.id, {
      frame: "checkout.html",
      filePath: "Zeros Design/checkout.html",
      sourceVersion: currentFrame.sourceVersion,
      nodeIds: [],
      breadcrumb: ["Checkout"],
      rects: [{ x: 0, y: 0, width: 1440, height: 900 }],
      keyComputedStyles: {},
      updatedAt: Date.now(),
    });
    setDesignScreenshot({
      workspaceId: workspace.id,
      frame: "checkout.html",
      nodeId: null,
      mimeType: "image/png",
      data: Buffer.from("phase-two-image").toString("base64"),
      width: 1440,
      height: 900,
      scale: 1,
      capturedAt: Date.now(),
      sourceVersion: currentFrame.sourceVersion,
    });
    const connected = await connect();

    const frames = await connected.callTool({
      name: "list_frames",
      arguments: {},
    });
    expect(JSON.stringify(frames.content)).toContain("checkout.html");
    const selection = await connected.callTool({
      name: "get_selection",
      arguments: {},
    });
    expect(JSON.stringify(selection.content)).toContain("Checkout");
    const frame = await connected.callTool({
      name: "get_frame",
      arguments: { frame: "checkout.html", depth: 2 },
    });
    expect(JSON.stringify(frame.content)).toContain("sourcePath");
    expect(JSON.stringify(frame.content)).not.toContain("<!doctype");
    const screenshot = await connected.callTool({
      name: "screenshot_frame",
      arguments: { frame: "checkout.html" },
    });
    expect(screenshot.isError).not.toBe(true);
    expect(screenshot.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          mimeType: "image/png",
        }),
      ]),
    );
    const lint = await connected.callTool({
      name: "lint_design",
      arguments: { frame: "checkout.html" },
    });
    expect(lint.isError).not.toBe(true);
    const tokens = await connected.callTool({
      name: "get_tokens",
      arguments: {},
    });
    expect(JSON.stringify(tokens.content)).toContain("--accent");
    const guide = await connected.callTool({
      name: "get_guide",
      arguments: { topic: "workflow" },
    });
    expect(JSON.stringify(guide.content)).toContain("lint_design");
    expect(JSON.stringify(guide.content)).toContain("browser contrast");
  });

  it("refuses a screenshot captured from another frame generation", async () => {
    setDesignScreenshot({
      workspaceId: workspace.id,
      frame: "checkout.html",
      nodeId: null,
      mimeType: "image/png",
      data: Buffer.from("stale-phase-two-image").toString("base64"),
      width: 1440,
      height: 900,
      scale: 1,
      capturedAt: Date.now(),
      sourceVersion: "ffffffffffffffffffffffff",
    });
    const connected = await connect();

    const screenshot = await connected.callTool({
      name: "screenshot_frame",
      arguments: { frame: "checkout.html" },
    });
    expect(screenshot.isError).toBe(true);
    expect(JSON.stringify(screenshot.content)).toContain(
      "No rendered screenshot",
    );
  });

  it("does not expose a selection from another frame generation", async () => {
    setDesignSelection(workspace.id, {
      frame: "checkout.html",
      filePath: "Zeros Design/checkout.html",
      sourceVersion: "ffffffffffffffffffffffff",
      nodeIds: [],
      breadcrumb: ["Stale checkout"],
      rects: [{ x: 0, y: 0, width: 1440, height: 900 }],
      keyComputedStyles: {},
      updatedAt: Date.now(),
    });
    const connected = await connect();

    const selection = await connected.callTool({
      name: "get_selection",
      arguments: {},
    });
    expect(selection.isError).not.toBe(true);
    expect(JSON.stringify(selection.content)).toContain("Nothing is selected");
    expect(JSON.stringify(selection.content)).not.toContain("Stale checkout");
  });

  it("does not mint a URL for code, archived, or unknown workspaces", () => {
    workspace = { ...workspace, kind: "code" };
    expect(server.urlForWorkspace(workspace.id)).toBeNull();
    workspace = { ...workspace, kind: "design", archivedAt: Date.now() };
    expect(server.urlForWorkspace(workspace.id)).toBeNull();
    expect(server.urlForWorkspace("missing")).toBeNull();
  });

  it("routes MCP style writes through the byte-identical inspector mutation layer", async () => {
    const before = await readDesignFrame(root, "checkout.html");
    const main = before.tree[0];
    const target = path.join(root, DESIGN_DIRECTORY_NAME, "checkout.html");
    const initialSource = await readFile(target, "utf8");
    const connected = await connect();

    const response = await connected.callTool({
      name: "update_styles",
      arguments: {
        frame: "checkout.html",
        nodeId: main!.oid,
        sourceVersion: before.sourceVersion,
        styles: { padding: "40px", "background-color": "var(--bg2)" },
      },
    });
    expect(response.isError).not.toBe(true);
    const mcpSource = await readFile(target, "utf8");

    await writeFile(target, initialSource, "utf8");
    const restored = await readDesignFrame(root, "checkout.html");
    await updateDesignNodeStyles(root, {
      frame: "checkout.html",
      nodeId: main!.oid!,
      sourceVersion: restored.sourceVersion,
      styles: { padding: "40px", "background-color": "var(--bg2)" },
    });
    expect(await readFile(target, "utf8")).toBe(mcpSource);
  });

  it("rejects stale structured writes without changing the authored frame", async () => {
    const before = await readDesignFrame(root, "checkout.html");
    const heading = before.tree[0]?.children[0];
    const target = path.join(root, DESIGN_DIRECTORY_NAME, "checkout.html");
    const source = await readFile(target, "utf8");
    const connected = await connect();

    const response = await connected.callTool({
      name: "set_text",
      arguments: {
        frame: "checkout.html",
        nodeId: heading!.oid,
        sourceVersion: "ffffffffffffffffffffffff",
        text: "Stale edit",
      },
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain(
      "changed before the mutation",
    );
    expect(await readFile(target, "utf8")).toBe(source);
  });
});
