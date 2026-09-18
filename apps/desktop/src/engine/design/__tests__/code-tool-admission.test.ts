import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../git";
import type { AgentSessionToolInput } from "../../agents/session-tools";
import { initializeDesignDocument, DESIGN_DIRECTORY_NAME } from "../document";
import {
  resolveCodeDesignTarget,
  DesignCodeToolAdmissions,
} from "../code-tool-admission";
import { parseDesignManifest, serializeDesignManifest } from "../manifest";
import { decodeCanvasFile } from "../canvas-file";
import { useLegacyDesignStorage } from "./storage-fixtures";
import { DesignAgentMcpServer } from "../design-agent-mcp";

describe("Code Design target admission", () => {
  let root: string;
  let workspace: Workspace | null;
  let input: AgentSessionToolInput;
  const options = {
    resolveWorkspace: () => workspace,
    workspaceIdForCwd: () => workspace?.id ?? null,
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-code-design-admission-"));
    await initializeDesignDocument(root);
    workspace = {
      id: "workspace",
      path: root,
      repoRoot: root,
      kind: "code",
      placement: "local",
      archivedAt: null,
    } as Workspace;
    input = {
      executionId: "execution",
      workspaceId: "workspace",
      cwd: root,
      conversationId: "conversation",
      signal: new AbortController().signal,
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function conflictManifest() {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "Initial",
    );
    const file = `${DESIGN_DIRECTORY_NAME}/design.toml`;
    const oid = git("rev-parse", `HEAD:${file}`);
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: root,
      input: `0 ${"0".repeat(40)}\t${file}\n100644 ${oid} 2\t${file}\n100644 ${oid} 3\t${file}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  it.each(["admission", "prompt"])(
    "keeps Code usable when a Design index conflict appears before %s",
    async (stage) => {
      let mode: "code" | "design" = "code";
      const owner = new DesignCodeToolAdmissions({
        ...options,
        mode: () => ({
          get: () => ({ mode, revision: 0 }),
          set: () => {
            throw new Error("unused");
          },
        }),
      });
      if (stage === "admission") conflictManifest();
      const tools = await owner.admit(input);
      try {
        if (stage === "prompt") conflictManifest();
        expect(await tools!.preparePrompt!()).toContain(
          "Current composer mode: Code",
        );
        mode = "design";
        await expect(tools!.preparePrompt!()).rejects.toThrow("Git conflict");
        mode = "code";
        execFileSync("git", ["add", `${DESIGN_DIRECTORY_NAME}/design.toml`], {
          cwd: root,
        });
        expect(await tools!.preparePrompt!()).toContain(DESIGN_DIRECTORY_NAME);
        workspace = null;
        await expect(tools!.preparePrompt!()).rejects.toThrow("workspace owning");
      } finally {
        await tools?.dispose();
      }
    },
  );

  it("keeps Code usable with a Design conflict when optional MCP startup fails", async () => {
    vi.spyOn(DesignAgentMcpServer.prototype, "start").mockRejectedValue(
      new Error("Transport unavailable"),
    );
    const owner = new DesignCodeToolAdmissions({
      ...options,
      mode: () => ({
        get: () => ({ mode: "code", revision: 0 }),
        set: () => {
          throw new Error("unused");
        },
      }),
    });
    const tools = await owner.admit(input);
    try {
      conflictManifest();
      expect(await tools!.preparePrompt!()).toContain(
        "Current composer mode: Code",
      );
      workspace = null;
      await expect(tools!.preparePrompt!()).rejects.toThrow("workspace owning");
    } finally {
      await tools?.dispose();
    }
  });

  it("preserves cancellation when optional Design discovery fails", async () => {
    const controller = new AbortController();
    const owner = new DesignCodeToolAdmissions({
      ...options,
      resolveTarget: async () => {
        controller.abort(new Error("Cancelled"));
        throw new Error("Discovery failed");
      },
    });
    await expect(
      owner.admit({ ...input, signal: controller.signal }),
    ).rejects.toThrow("Cancelled");
  });

  it("instructs cloud Design conversations to use the API", async () => {
    workspace = { ...workspace!, placement: "cloud" };
    const owner = new DesignCodeToolAdmissions({
      ...options,
      cloudWorker: true,
      mode: () => ({
        get: () => ({ mode: "design", revision: 1 }),
        set: () => {
          throw new Error("unused");
        },
      }),
    });
    const tools = await owner.admit(input);
    try {
      const instruction = await tools!.preparePrompt!();
      expect(instruction).toContain("design_transaction_apply");
      expect(instruction).not.toContain("Use your normal Read, Write, Edit");
    } finally {
      await tools?.dispose();
    }
  });

  it.each(["startup", "capacity"])(
    "does not fall back to native cloud Design writes on MCP %s failure",
    async (failure) => {
      workspace = { ...workspace!, placement: "cloud" };
      const owner = new DesignCodeToolAdmissions({
        ...options,
        cloudWorker: true,
        mode: () => ({
          get: () => ({ mode: "design", revision: 1 }),
          set: () => {
            throw new Error("unused");
          },
        }),
      });
      const admitted = [];
      try {
        if (failure === "startup")
          vi.spyOn(DesignAgentMcpServer.prototype, "start").mockRejectedValue(
            new Error("Transport unavailable"),
          );
        else
          for (let index = 0; index < 16; index++)
            admitted.push(await owner.admit(input));
        const tools = await owner.admit(input);
        admitted.push(tools);
        expect(tools!.mcpServers).toEqual([]);
        await expect(tools!.preparePrompt!()).rejects.toThrow(
          "Design tools are unavailable",
        );
      } finally {
        await Promise.all(admitted.map((tools) => tools?.dispose()));
      }
    },
  );

  it("preserves native Design authoring if optional MCP startup fails", async () => {
    vi.spyOn(DesignAgentMcpServer.prototype, "start").mockRejectedValue(new Error("Transport unavailable"));
    const owner = new DesignCodeToolAdmissions({ ...options, mode: () => ({ get: () => ({ mode: "design", revision: 1 }), set: () => { throw new Error("unused"); } }) });
    const tools = await owner.admit(input);
    try {
      expect(tools!.mcpServers).toEqual([]);
      expect(await tools!.preparePrompt!()).toContain("normal Read, Write, Edit");
      expect(await tools!.preparePrompt!()).toContain(DESIGN_DIRECTORY_NAME);
    } finally { await tools?.dispose(); }
  });

  it("resolves the manifest in Code view and retains the exact target across UI mode changes", async () => {
    const target = await resolveCodeDesignTarget(input, options);
    expect(target).toMatchObject({
      workspaceId: "workspace",
      directory: DESIGN_DIRECTORY_NAME,
      actorId: "conversation",
    });
    target!.assertCurrent();
    workspace = { ...workspace!, kind: "design" };
    target!.assertCurrent();
    workspace = null;
    expect(() => target!.assertCurrent()).toThrow("authority changed");
  });

  it("keeps Code inspection observational and migrates legacy metadata before a Design prompt", async () => {
    const manifestFile = path.join(root, DESIGN_DIRECTORY_NAME, "design.toml");
    const canvasFile = path.join(root, DESIGN_DIRECTORY_NAME, "canvas.json");
    const id = parseDesignManifest(await readFile(manifestFile, "utf8"))!.id;
    const legacy = serializeDesignManifest(id, decodeCanvasFile(await readFile(canvasFile, "utf8")));
    await writeFile(manifestFile, legacy);
    await rm(canvasFile);
    let mode: "code" | "design" = "code";
    const owner = new DesignCodeToolAdmissions({ ...options, mode: () => ({ get: () => ({ mode, revision: mode === "code" ? 0 : 1 }), set: () => { throw new Error("unused"); } }) });
    const tools = await owner.admit(input);
    try {
      expect(await tools!.preparePrompt!()).toContain(DESIGN_DIRECTORY_NAME);
      expect(await readFile(manifestFile, "utf8")).toBe(legacy);
      mode = "design";
      expect(await tools!.preparePrompt!()).toContain("normal Read, Write, Edit");
      expect(parseDesignManifest(await readFile(manifestFile, "utf8"))).toEqual({ id, canvas: "canvas.json" });
      expect(JSON.parse(await readFile(canvasFile, "utf8")).version).toBe(1);
    } finally { await tools!.dispose(); }
  });

  it("keeps implicitly discovered legacy frames and their inline titles when entering Design", async () => {
    useLegacyDesignStorage(root, DESIGN_DIRECTORY_NAME, ".zeros/design-dir.toml");
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, "old.html"), '<!doctype html><html><head><title>Legacy title</title></head><body><p>Keep</p></body></html>');
    const owner = new DesignCodeToolAdmissions({ ...options, mode: () => ({ get: () => ({ mode: "design", revision: 1 }), set: () => { throw new Error("unused"); } }) });
    const tools = await owner.admit(input);
    try {
      await tools!.preparePrompt!();
      const canvas = decodeCanvasFile(await readFile(path.join(root, DESIGN_DIRECTORY_NAME, "canvas.json"), "utf8"));
      expect(canvas.frame_info).toMatchObject({ "old.html": { title: "Legacy title" } });
    } finally { await tools!.dispose(); }
  });

  it("admits a cloud workspace only on its engine worker and denies a more-specific nested owner", async () => {
    workspace = { ...workspace!, placement: "cloud" };
    expect(await resolveCodeDesignTarget(input, options)).toBeNull();
    expect(
      await resolveCodeDesignTarget(input, { ...options, cloudWorker: true }),
    ).not.toBeNull();
    expect(
      await resolveCodeDesignTarget(input, {
        ...options,
        cloudWorker: true,
        workspaceIdForCwd: () => "nested-workspace",
      }),
    ).toBeNull();
  });

  it("revokes an existing grant when a more-specific workspace takes ownership of its cwd", async () => {
    let owner = workspace!.id;
    const target = await resolveCodeDesignTarget(input, {
      ...options,
      workspaceIdForCwd: () => owner,
    });
    target!.assertCurrent();
    owner = "nested-workspace";
    expect(() => target!.assertCurrent()).toThrow("authority changed");
  });

  it("bounds live admissions and releases a slot only after transport disposal", async () => {
    const owner = new DesignCodeToolAdmissions(options);
    const admitted = [];
    try {
      for (let index = 0; index < 16; index++)
        admitted.push(
          await owner.admit({ ...input, executionId: `execution-${index}` }),
        );
      expect(admitted.every(Boolean)).toBe(true);
      expect(
        await owner.admit({ ...input, executionId: "overflow" }),
      ).toBeNull();
      await admitted.pop()!.dispose();
      const replacement = await owner.admit({
        ...input,
        executionId: "replacement",
      });
      expect(replacement).not.toBeNull();
      admitted.push(replacement);
    } finally {
      await Promise.all(admitted.map((entry) => entry!.dispose()));
    }
  });

  it("cancels a pending resolver without allocating a live transport", async () => {
    const controller = new AbortController();
    const target = await resolveCodeDesignTarget(input, options);
    let finish!: (value: typeof target) => void;
    const owner = new DesignCodeToolAdmissions({
      resolveTarget: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const pending = owner.admit({ ...input, signal: controller.signal }).then(
      () => null,
      (error: unknown) => error,
    );
    controller.abort();
    finish(target);
    expect(await pending).toBeInstanceOf(Error);
  });

  it("reports unavailable tools before a Design prompt instead of silently running without the API", async () => {
    workspace = null;
    let mode: "code" | "design" = "code";
    const owner = new DesignCodeToolAdmissions({
      ...options,
      mode: () => ({
        get: () => ({ mode, revision: 0 }),
        set: () => { throw new Error("Unavailable"); },
      }),
    });
    const tools = await owner.admit(input);
    try {
      expect(tools).not.toBeNull();
      expect(tools!.mcpServers).toEqual([]);
      expect(await tools!.preparePrompt!()).toContain("Current composer mode: Code");
      mode = "design";
      await expect(tools!.preparePrompt!()).rejects.toThrow("Design tools are unavailable");
    } finally {
      await tools?.dispose();
    }
  });
});
