import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DesignCodeTools } from "../code-tools";
import { DesignAgentMcpServer } from "../design-agent-mcp";
import {
  createDesignFrame,
  initializeDesignDocument,
  readDesignWebDocumentState,
  DESIGN_DIRECTORY_NAME,
} from "../document";
import { designDirectoryEntry } from "../metadata";
import { getWorkspaceDesignApi, DesignDraftStore } from "../design-api";
import { DesignRequestStore } from "../request-store";
import { withDesignWorkspaceMutation } from "../document-write-lock";
import type { DesignTransaction } from "@zeros/design-core";

describe("Code-session Design tools", () => {
  let root: string;
  let directoryId: string;
  let frame: string;
  let revision: string;
  let nodeId: string;
  let valid: boolean;
  let handler: DesignCodeTools;
  let changed: ReturnType<typeof vi.fn<() => void>>;
  const actorId = "conversation-1";
  const sessions: DesignCodeTools[] = [];
  const servers: DesignAgentMcpServer[] = [];
  const clients: Client[] = [];

  function session(
    actor = actorId,
    options: ConstructorParameters<typeof DesignCodeTools>[1] = {},
  ) {
    const value = new DesignCodeTools(
      {
        workspaceId: "workspace-1",
        workspacePath: root,
        directory: DESIGN_DIRECTORY_NAME,
        directoryId,
        actorId: actor,
        assertCurrent: () => {
          if (!valid) throw new Error("Target was removed or replaced.");
        },
      },
      { onChanged: changed, mode: () => ({ mode: "design", revision: 0 }), ...options },
    );
    sessions.push(value);
    return value;
  }
  async function call(name: string, input: unknown = {}, tools = handler) {
    const result = await tools.callTool(
      name,
      input,
      new AbortController().signal,
    );
    const part = result.content[0];
    if (part?.type !== "text") throw new Error("Missing result");
    return JSON.parse(part.text);
  }
  function transaction(
    id = "change-1",
    baseRevision = revision,
  ): DesignTransaction {
    return {
      schemaVersion: 1,
      transactionId: id,
      documentId: `frame:${frame}`,
      baseRevision,
      actor: { kind: "agent", id: actorId },
      intent: "Change heading",
      createdAt: Date.now(),
      operations: [
        {
          operationId: `${id}-text`,
          type: "node.set-text",
          nodeId,
          text: "Agent result",
        },
      ],
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-code-design-tools-"));
    await initializeDesignDocument(root);
    frame = (await createDesignFrame(root, { title: "Code tools" })).file;
    const state = await readDesignWebDocumentState(root, frame);
    revision = state.revision;
    nodeId = /<main data-oid="([^"]+)"/.exec(state.files[frame]!)![1]!;
    directoryId = designDirectoryEntry(root, DESIGN_DIRECTORY_NAME)!.id;
    valid = true;
    changed = vi.fn();
    handler = session();
  });
  afterEach(async () => {
    sessions.splice(0).forEach((value) => value.dispose());
    await Promise.all(
      clients.splice(0).map((value) => value.close().catch(() => {})),
    );
    await Promise.all(servers.splice(0).map((value) => value.stop()));
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each(["Home.HTML", "Home.HtMl"])(
    "opens and edits the listed frame %s",
    async (file) => {
      const folder = path.join(root, DESIGN_DIRECTORY_NAME);
      const canvasPath = path.join(folder, "canvas.json");
      const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
      canvas.frames.home = {
        kind: "html",
        source: file,
        title: "Home",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
      };
      canvas.pages[0].frames.push("home");
      await writeFile(
        path.join(folder, file),
        '<!doctype html><html><body><h1 data-oid="heading">Home</h1></body></html>',
      );
      await writeFile(canvasPath, JSON.stringify(canvas));
      const listed = (await call("design_document_list")).frames.find(
        (entry: { file: string }) => entry.file === file,
      );
      expect(listed.documentId).toBe(`frame:${file}`);
      const opened = await call("design_document_open", {
        documentId: listed.documentId,
      });
      const changed = await call("design_transaction_apply", {
        transaction: {
          ...transaction("uppercase-edit", opened.revision),
          documentId: listed.documentId,
          operations: [
            {
              operationId: "heading",
              type: "node.set-text",
              nodeId: "heading",
              text: "Updated",
            },
          ],
        },
      });
      expect(await readFile(path.join(folder, file), "utf8")).toContain(
        ">Updated</h1>",
      );
      await call("design_lint", {
        documentId: listed.documentId,
        expectedRevision: changed.revision,
      });
    },
  );

  it("completes list/open/propose/apply/render through MCP without a renderer", async () => {
    const server = new DesignAgentMcpServer({ handler, token: handler.token });
    servers.push(server);
    await server.start();
    const client = new Client({
      name: "headless-design-workflow",
      version: "1",
    });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${handler.token}` } },
      }),
    );
    const mcp = async (name: string, input: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: input });
      const content = result.content as Array<{ text: string }>;
      return JSON.parse(content[0]!.text);
    };
    expect(
      (await client.listTools()).tools.map((tool) => tool.name),
    ).not.toContain("design_capture");
    expect((await mcp("design_document_list")).frames[0].documentId).toBe(
      `frame:${frame}`,
    );
    expect(
      (await mcp("design_document_open", { documentId: `frame:${frame}` }))
        .revision,
    ).toBe(revision);
    const proposal = await mcp("design_proposal_create", {
      transaction: transaction(),
    });
    expect(proposal.status).toBe("proposed");
    expect((await readDesignWebDocumentState(root, frame)).revision).toBe(
      revision,
    );
    const applied = await mcp("design_proposal_resolve", {
      requestId: "change-1",
      decision: "apply",
    });
    expect(applied.receipt.actor).toEqual({ kind: "agent", id: actorId });
    const render = await mcp("design_render", {
      documentId: `frame:${frame}`,
      expectedRevision: applied.revision,
    });
    expect(render.html).toContain("Agent result");
    expect(render.revision).toBe(applied.revision);
    expect(render.sourceVersion).toMatch(/^[a-f0-9]{24}$/);
    expect(render.contentHash).toBe(
      createHash("sha256").update(render.html, "utf8").digest("hex"),
    );
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("keeps inspection available in Code and rejects Design writes", async () => {
    let mode = { mode: "code" as "code" | "design", revision: 0 };
    const tools = session(actorId, { mode: () => mode });
    expect((await call("design_document_list", {}, tools)).frames).toHaveLength(1);
    await expect(call("design_transaction_apply", { transaction: transaction() }, tools)).rejects.toThrow("Design mode");
    expect((await readDesignWebDocumentState(root, frame)).revision).toBe(revision);
    mode = { mode: "design", revision: 1 };
    expect((await call("design_transaction_apply", { transaction: transaction() }, tools)).revision).not.toBe(revision);
  });

  it("rejects a queued write after leaving and reentering Design mode", async () => {
    let mode = { mode: "design" as "code" | "design", revision: 1 };
    const tools = session(actorId, { mode: () => mode });
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const lock = withDesignWorkspaceMutation(root, async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await ready;
    const pending = call("design_transaction_apply", { transaction: transaction() }, tools);
    const outcome = pending.catch((error: unknown) => error);
    mode = { mode: "code", revision: 2 };
    mode = { mode: "design", revision: 3 };
    release();
    await lock;
    expect(await outcome).toBeInstanceOf(Error);
    expect((await readDesignWebDocumentState(root, frame)).revision).toBe(revision);
  });

  it("does not hold the Design write lane while a capture host is rendering", async () => {
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const capturing = session(actorId, {
      renderer: {
        async render({ state }) {
          entered();
          await held;
          throw new Error(`fixture completed ${state.revision}`);
        },
      },
    });
    const capture = call(
      "design_capture",
      {
        documentId: `frame:${frame}`,
        expectedRevision: revision,
        width: 1,
        height: 1,
      },
      capturing,
    ).catch((error) => error);
    await started;
    let admitted = false;
    const edit = withDesignWorkspaceMutation(root, async () => {
      admitted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const wasAdmittedWhileRendering = admitted;
    finish();
    await capture;
    await edit;
    expect(wasAdmittedWhileRendering).toBe(true);
  });

  it("returns a durable lost-reply receipt after restart without overwriting a later human edit", async () => {
    const tx = transaction();
    const applied = await call("design_transaction_apply", { transaction: tx });
    await getWorkspaceDesignApi(root).apply({
      ...transaction("human", applied.revision),
      actor: { kind: "human", id: "designer" },
      operations: [
        {
          operationId: "human-text",
          type: "node.set-text",
          nodeId,
          text: "Human edit",
        },
      ],
    });
    handler.dispose();
    const resumed = session();
    expect(
      await call("design_transaction_apply", { transaction: tx }, resumed),
    ).toEqual(applied);
    expect(
      (await readDesignWebDocumentState(root, frame)).files[frame],
    ).toContain("Human edit");
    await expect(
      call(
        "design_transaction_apply",
        { transaction: { ...tx, intent: "Different body" } },
        resumed,
      ),
    ).rejects.toThrow("reused");
    expect(
      await call(
        "design_request_status",
        { requestId: tx.transactionId },
        session("another-conversation"),
      ),
    ).toEqual({ status: "unknown" });
  });

  it("never replays a request interrupted between its commit and durable receipt", async () => {
    const tx = transaction();
    const write = DesignRequestStore.prototype.write;
    vi.spyOn(DesignRequestStore.prototype, "write").mockImplementation(
      function (this: DesignRequestStore, entries) {
        if (entries.some((entry) => entry.status === "committed"))
          throw new Error("Simulated lost receipt");
        return write.call(this, entries);
      },
    );
    await expect(
      call("design_transaction_apply", { transaction: tx }),
    ).rejects.toThrow("lost receipt");
    vi.restoreAllMocks();
    const resumed = session();
    expect(
      (
        await call(
          "design_request_status",
          { requestId: tx.transactionId },
          resumed,
        )
      ).status,
    ).toBe("indeterminate");
    await expect(
      call("design_transaction_apply", { transaction: tx }, resumed),
    ).rejects.toThrow("indeterminate");
    expect(
      (await readDesignWebDocumentState(root, frame)).files[frame],
    ).toContain("Agent result");
  });

  it("retains a stale proposal for review and does not undo another actor's edit", async () => {
    const tx = transaction();
    await call("design_proposal_create", { transaction: tx });
    const human = await getWorkspaceDesignApi(root).apply({
      ...transaction("human-first"),
      actor: { kind: "human", id: "designer" },
    });
    await expect(
      call("design_proposal_resolve", {
        requestId: tx.transactionId,
        decision: "apply",
      }),
    ).rejects.toThrow();
    expect(
      (await call("design_request_status", { requestId: tx.transactionId }))
        .status,
    ).toBe("proposed");
    expect(
      await call("design_history_undo", {
        requestId: "undo-human",
        createdAt: Date.now(),
        documentId: tx.documentId,
        expectedRevision: human.revision,
      }),
    ).toBeNull();
    expect((await readDesignWebDocumentState(root, frame)).revision).toBe(
      human.revision,
    );
  });

  it("rejects actor spoofing, unimplemented tools, path fields, stale targets, and revoked sessions", async () => {
    await expect(
      call("design_transaction_apply", {
        transaction: {
          ...transaction(),
          actor: { kind: "human", id: "designer" },
        },
      }),
    ).rejects.toThrow("actor");
    await expect(
      call("design_document_open", { documentId: "frame:../outside.html" }),
    ).rejects.toThrow();
    await expect(
      call("design_document_list", { workspacePath: "/other" }),
    ).rejects.toThrow();
    await expect(
      call("design_capture", {
        documentId: `frame:${frame}`,
        expectedRevision: revision,
        width: 800,
        height: 600,
      }),
    ).rejects.toThrow("unavailable");
    valid = false;
    await expect(call("design_document_list")).rejects.toThrow("replaced");
    valid = true;
    handler.dispose();
    await expect(call("design_document_list")).rejects.toThrow("revoked");
  });

  it("supports frame lifecycle with durable request IDs and exact revision checks", async () => {
    const createdAt = Date.now();
    const created = await call("design_frame_create", {
      requestId: "create",
      createdAt: createdAt,
      title: "New",
    });
    expect(
      await call("design_frame_create", {
        requestId: "create",
        createdAt: createdAt,
        title: "New",
      }),
    ).toEqual(created);
    const opened = await call("design_document_open", {
      documentId: `frame:${created.file}`,
    });
    const renamed = await call("design_frame_rename", {
      requestId: "rename",
      createdAt: Date.now(),
      documentId: opened.documentId,
      expectedRevision: opened.revision,
      title: "Renamed",
    });
    expect(renamed.file).toBe(created.file);
    expect(renamed.title).toBe("Renamed");
    const fresh = await call("design_document_open", {
      documentId: opened.documentId,
    });
    await call("design_frame_delete", {
      requestId: "delete",
      createdAt: Date.now(),
      documentId: opened.documentId,
      expectedRevision: fresh.revision,
    });
    await expect(
      call("design_document_open", { documentId: opened.documentId }),
    ).rejects.toThrow();
  });

  it("records a known revision conflict as rejected, leaving bounded history available for fresh work", async () => {
    const tx = transaction("conflict");
    await call("design_transaction_apply", {
      transaction: transaction("first"),
    });
    await expect(
      call("design_transaction_apply", { transaction: tx }),
    ).rejects.toThrow();
    expect(
      (await call("design_request_status", { requestId: tx.transactionId }))
        .status,
    ).toBe("rejected");
  });

  it("cancels a request paused before journal admission without writing authored files", async () => {
    const controller = new AbortController();
    const originalRead = DesignDraftStore.prototype.read;
    let entered!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(DesignDraftStore.prototype, "read").mockImplementationOnce(
      async function (this: DesignDraftStore, id) {
        const state = await originalRead.call(this, id);
        entered();
        await held;
        return state;
      },
    );
    const pending = handler
      .callTool(
        "design_transaction_apply",
        { transaction: transaction("cancel") },
        controller.signal,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    await reached;
    controller.abort();
    resume();
    expect(await pending).toBeInstanceOf(Error);
    expect((await readDesignWebDocumentState(root, frame)).revision).toBe(
      revision,
    );
    expect(changed).not.toHaveBeenCalled();
  });

  it("expires an execution grant and cannot reactivate it after a clock rewind", async () => {
    let now = Date.now();
    const timed = session(actorId, { now: () => now });
    const capabilities = await call("design_capabilities", {}, timed);
    expect(capabilities.expiresAt).toBeGreaterThan(now);
    now += 25 * 60 * 60_000;
    await expect(call("design_document_list", {}, timed)).rejects.toThrow(
      "expired",
    );
    now -= 25 * 60 * 60_000;
    await expect(call("design_document_list", {}, timed)).rejects.toThrow(
      "revoked",
    );
  });
});
