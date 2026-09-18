import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ComposerModeSnapshot } from "@zeros/protocol/composer-mode";
import { ConversationDesignTools } from "../conversation-tools";
import { DesignAgentMcpServer } from "../design-agent-mcp";
import { resolveCodeDesignTarget } from "../code-tool-admission";
import {
  initializeDesignDocument,
  listDesignFrames,
  readDesignWebDocumentState,
} from "../document";
import type { Workspace } from "../../git";

describe("shared conversation Design tools over MCP", () => {
  let root: string;
  let mode: ComposerModeSnapshot;
  let handler: ConversationDesignTools;
  let server: DesignAgentMcpServer;
  let client: Client;
  let options: ConstructorParameters<typeof ConversationDesignTools>[0];
  const changed = vi.fn();
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const first = (result.content as Array<{ text: string }>)[0]!;
    if (result.isError) throw new Error(first.text);
    return JSON.parse(first.text);
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-conversation-design-"));
    mode = { mode: "code", revision: 0 };
    changed.mockClear();
    const workspace = {
      id: "workspace",
      path: root,
      repoRoot: root,
      kind: "code",
      placement: "local",
      archivedAt: null,
    } as Workspace;
    options = {
      mode: {
        get: () => mode,
        set: (next, revision) => {
          if (revision !== mode.revision)
            throw new Error("Composer mode changed.");
          if (next !== mode.mode) mode = { mode: next, revision: revision + 1 };
          return mode;
        },
      },
      assertOwner: () => {},
      onChanged: changed,
      renderer: {
        render: async ({ state, viewport }) => ({
          mimeType: "image/png",
          bytes: Buffer.from(png, "base64"),
          width: viewport.width,
          height: viewport.height,
          revision: state.revision,
        }),
      },
      resolveTarget: () =>
        resolveCodeDesignTarget(
          {
            executionId: "execution",
            workspaceId: "workspace",
            conversationId: "conversation",
            cwd: root,
            signal: new AbortController().signal,
          },
          { resolveWorkspace: () => workspace },
        ),
    };
    handler = new ConversationDesignTools(options);
    server = new DesignAgentMcpServer({ handler, token: handler.token });
    await server.start();
    client = new Client({ name: "design-v1", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${handler.token}` } },
      }),
    );
  });
  afterEach(async () => {
    handler?.dispose();
    await client?.close();
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  });

  it("creates a directory and canvas frame in the same MCP session without a proposal", async () => {
    const catalog = await client.listTools();
    expect(catalog.tools.map((tool) => tool.name)).not.toContain(
      "design_proposal_create",
    );
    expect((await call("design_capabilities")).directoryId).toBeNull();
    await expect(
      call("design_frame_create", {
        requestId: "create-1",
        createdAt: Date.now(),
        title: "Landing",
      }),
    ).rejects.toThrow("Design mode");
    const selected = await call("design_mode_set", {
      mode: "design",
      expectedRevision: 0,
    });
    expect(selected.systemInstruction).toContain(
      "Current composer mode: Design",
    );
    await initializeDesignDocument(root);
    const capabilities = await call("design_capabilities");
    expect(capabilities.designWritesEnabled).toBe(true);
    const request = {
      requestId: "create-1",
      createdAt: capabilities.serverTime,
      title: "Landing",
    };
    const created = await call("design_frame_create", request);
    expect(await call("design_frame_create", request)).toEqual(created);
    expect(await listDesignFrames(root)).toHaveLength(1);
    expect((await call("design_document_list")).frames).toHaveLength(1);
    const documentId = `frame:${created.file}`;
    const initial = await readDesignWebDocumentState(root, created.file);
    const nodeId = /<main data-oid="([^"]+)"/.exec(
      initial.files[created.file]!,
    )![1]!;
    expect((await call("design_document_open", { documentId })).revision).toBe(
      initial.revision,
    );
    await call("design_projection_read", {
      documentId,
      expectedRevision: initial.revision,
    });
    const edit = await call("design_transaction_apply", {
      transaction: {
        schemaVersion: 1,
        transactionId: "landing-heading",
        createdAt: capabilities.serverTime,
        actor: { kind: "agent", id: "conversation" },
        intent: "Write the landing page heading",
        documentId,
        baseRevision: initial.revision,
        operations: [
          {
            operationId: "heading",
            type: "node.set-text",
            nodeId,
            text: "Welcome to the canvas",
          },
        ],
      },
    });
    expect(
      (await readDesignWebDocumentState(root, created.file)).files[
        created.file
      ],
    ).toContain("Welcome to the canvas");
    await call("design_lint", { documentId, expectedRevision: edit.revision });
    await call("design_history_undo", {
      requestId: "undo-heading",
      createdAt: capabilities.serverTime,
      documentId,
      expectedRevision: edit.revision,
    });
    expect(
      (await readDesignWebDocumentState(root, created.file)).files,
    ).toEqual(initial.files);
    expect(changed).toHaveBeenCalledTimes(3); // Create, edit and undo invalidate canvas reads; receipt replay does not.
    await call("design_mode_set", { mode: "code", expectedRevision: 1 });
    expect((await call("design_document_list")).frames).toHaveLength(1);
    await expect(call("design_proposal_create", {})).rejects.toThrow(
      "unavailable",
    );
    expect(await client.listTools()).toEqual(catalog);
  });

  it("rejects stale switches and refreshes instructions after each selection", async () => {
    expect(await handler.preparePrompt()).toContain("Current composer mode: Code");
    await call("design_mode_set", { mode: "design", expectedRevision: 0 });
    await expect(
      call("design_mode_set", { mode: "code", expectedRevision: 0 }),
    ).rejects.toThrow("changed");
    expect(await handler.preparePrompt()).toContain("Current composer mode: Design");
  });

  it("keeps API authoring available after switching a cloud conversation to Design", async () => {
    await initializeDesignDocument(root);
    const cloud = new ConversationDesignTools({
      ...options,
      authoringMethod: "api",
    });
    const invoke = async (name: string, args: unknown) => {
      const result = await cloud.callTool(
        name,
        args,
        new AbortController().signal,
      );
      const first = result.content[0];
      if (first?.type !== "text") throw new Error("Missing tool result");
      return JSON.parse(first.text);
    };
    try {
      const selected = await invoke("design_mode_set", {
        mode: "design",
        expectedRevision: 0,
      });
      expect(selected.systemInstruction).toContain("design_transaction_apply");
      expect(selected.systemInstruction).not.toContain(
        "Use your normal Read, Write, Edit",
      );
      const caps = await invoke("design_capabilities", {});
      const created = await invoke("design_frame_create", {
        requestId: "cloud-frame",
        createdAt: caps.serverTime,
        title: "Cloud frame",
      });
      expect((await listDesignFrames(root))[0].file).toBe(created.file);
      expect(await cloud.preparePrompt()).toContain("design_transaction_apply");
    } finally {
      cloud.dispose();
    }
  });

  it.each(["cancel", "owner", "mode"])(
    "does not hide a %s change behind an optional Design lookup failure",
    async (change) => {
      let reject!: (error: Error) => void;
      let ownerValid = true;
      const guarded = new ConversationDesignTools({
        ...options,
        assertOwner: () => {
          if (!ownerValid) throw new Error("Owner changed");
        },
        resolveTarget: () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      });
      const pending = guarded.preparePrompt();
      try {
        if (change === "cancel") guarded.cancel();
        if (change === "owner") ownerValid = false;
        if (change === "mode") mode = { mode: "design", revision: 1 };
        reject(new Error("Discovery failed"));
        await expect(pending).rejects.toThrow(
          change === "cancel" ? /abort/i : /changed/,
        );
      } finally {
        guarded.dispose();
      }
    },
  );

  it("returns Capture as a normal MCP image and bounded metadata, including in Code mode", async () => {
    await initializeDesignDocument(root);
    await call("design_mode_set", { mode: "design", expectedRevision: 0 });
    const caps = await call("design_capabilities");
    const frame = await call("design_frame_create", {
      requestId: "capture-frame",
      createdAt: caps.serverTime,
      title: "Capture",
    });
    const { revision } = await readDesignWebDocumentState(root, frame.file);
    await call("design_mode_set", { mode: "code", expectedRevision: 1 });
    const result = await client.callTool({
      name: "design_capture",
      arguments: {
        documentId: `frame:${frame.file}`,
        expectedRevision: revision,
        width: 1,
        height: 1,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.not.stringContaining(png) },
      { type: "image", mimeType: "image/png", data: png },
    ]);
    expect(
      JSON.parse((result.content as Array<{ text: string }>)[0]!.text),
    ).toMatchObject({ revision, width: 1, height: 1 });
  });

  it("suspends directory authority and cancels calls without replacing MCP", async () => {
    await initializeDesignDocument(root);
    await call("design_document_list");
    const resume = handler.suspend();
    await expect(call("design_document_list")).rejects.toThrow(
      "directory is changing",
    );
    resume();
    expect((await call("design_document_list")).frames).toHaveLength(0);
    handler.cancel();
    await expect(call("design_document_list")).rejects.toThrow();
    await expect(handler.preparePrompt()).rejects.toThrow();
    handler.beginPrompt();
    await handler.preparePrompt();
    expect((await call("design_document_list")).frames).toHaveLength(0);
  });
});
