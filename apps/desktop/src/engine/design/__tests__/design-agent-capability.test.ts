import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DesignAgentCapabilityError,
  DesignAgentCapabilityManager,
} from "../design-agent-capability";
import {
  createDesignFrame,
  DESIGN_DIRECTORY_NAME,
  initializeDesignDocument,
  readDesignWebDocumentState,
} from "../document";
import { getWorkspaceDesignApi } from "../design-api";

const execFileAsync = promisify(execFile);

describe("Design-agent capability", () => {
  let root: string;
  let frame: string;
  let nodeId: string;
  let revision: string;
  let now: number;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-agent-capability-"));
    await initializeDesignDocument(root);
    const created = await createDesignFrame(root, { title: "Agent draft" });
    frame = created.file;
    const state = await readDesignWebDocumentState(root, frame);
    revision = state.revision;
    nodeId = /<main data-oid="([^"]+)"/.exec(state.files[frame]!)![1]!;
    now = 10_000;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function grant(
    manager: DesignAgentCapabilityManager,
    options: {
      allowedOperationTypes?: readonly string[];
      ttlMs?: number;
    } = {},
  ) {
    return manager.create({
      workspaceId: "workspace-1",
      workspacePath: root,
      agentRunId: "design-run-1",
      documentId: `frame:${frame}`,
      expectedRevision: revision,
      ...(options.allowedOperationTypes
        ? { allowedOperationTypes: options.allowedOperationTypes }
        : {}),
      ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
    });
  }

  function transaction(input: {
    id: string;
    baseRevision: string;
    type?: "node.set-text" | "node.set-styles";
  }) {
    const type = input.type ?? "node.set-text";
    return {
      schemaVersion: 1 as const,
      transactionId: input.id,
      documentId: `frame:${frame}`,
      baseRevision: input.baseRevision,
      actor: { kind: "agent" as const, id: "design-run-1" },
      intent: "Update the Design draft",
      createdAt: now,
      operations: [
        type === "node.set-text"
          ? {
              operationId: `${input.id}-operation`,
              type,
              nodeId,
              text: "Designed by the agent",
            }
          : {
              operationId: `${input.id}-operation`,
              type,
              nodeId,
              styles: { padding: "48px" },
              scope: "auto" as const,
              responsiveContext: "base",
              stateContext: "default",
            },
      ],
    };
  }

  it("keeps a persistent run authorized through API transactions without committing Git", async () => {
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Zeros Test"], {
      cwd: root,
    });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: root,
    });
    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await execFileAsync("git", ["commit", "-q", "-m", "initial"], {
      cwd: root,
    });
    const manager = new DesignAgentCapabilityManager({ now: () => now });
    const capability = await grant(manager);

    const applied = await manager.apply(
      capability.token,
      transaction({ id: "agent-text", baseRevision: revision }),
    );
    expect(applied.receipt.status).toBe("applied");
    expect(applied.revision).not.toBe(revision);
    const duplicate = await manager.apply(
      capability.token,
      transaction({ id: "agent-text", baseRevision: revision }),
    );
    expect(duplicate.receipt.status).toBe("duplicate");
    expect(manager.activeCount()).toBe(1);
    expect(
      await readFile(path.join(root, DESIGN_DIRECTORY_NAME, frame), "utf8"),
    ).toContain("Designed by the agent");
    expect(
      (await execFileAsync("git", ["status", "--porcelain"], { cwd: root }))
        .stdout,
    ).toContain(`Zeros Design/${frame}`);
    expect(
      (await execFileAsync("git", ["rev-list", "--count", "HEAD"], {
        cwd: root,
      })).stdout.trim(),
    ).toBe("1");
  });

  it("binds actor, document, workspace, actions, and expiry to one opaque token", async () => {
    const manager = new DesignAgentCapabilityManager({ now: () => now });
    const capability = await grant(manager, {
      allowedOperationTypes: ["node.set-text"],
      ttlMs: 1_000,
    });
    expect(capability).toMatchObject({
      version: 1,
      workspaceId: "workspace-1",
      agentRunId: "design-run-1",
      documentId: `frame:${frame}`,
      expectedRevision: revision,
      allowedOperationTypes: ["node.set-text"],
      expiresAt: now + 1_000,
    });
    expect(capability.token).toMatch(/^[a-f0-9]{64}$/);

    await expect(
      manager.apply(
        capability.token,
        transaction({
          id: "forbidden-style",
          baseRevision: revision,
          type: "node.set-styles",
        }),
      ),
    ).rejects.toMatchObject({ code: "DESIGN_API_FORBIDDEN" });
    await expect(
      manager.apply(capability.token, {
        ...transaction({ id: "wrong-actor", baseRevision: revision }),
        actor: { kind: "agent", id: "another-run" },
      }),
    ).rejects.toMatchObject({ code: "DESIGN_API_FORBIDDEN" });

    now += 1_001;
    await expect(manager.open(capability.token)).rejects.toMatchObject({
      code: "DESIGN_AGENT_CAPABILITY_EXPIRED",
    });
    expect(manager.activeCount()).toBe(0);
  });

  it("fails stale agent mutations without overwriting a human draft", async () => {
    const manager = new DesignAgentCapabilityManager({ now: () => now });
    const capability = await grant(manager);
    const human = getWorkspaceDesignApi(root);
    const humanResult = await human.apply({
      ...transaction({ id: "human-first", baseRevision: revision }),
      actor: { kind: "human" as const, id: "designer" },
      operations: [
        {
          operationId: "human-text",
          type: "node.set-text" as const,
          nodeId,
          text: "Human draft wins",
        },
      ],
    });

    await expect(
      manager.apply(
        capability.token,
        transaction({ id: "stale-agent", baseRevision: revision }),
      ),
    ).rejects.toMatchObject({ code: "DESIGN_REVISION_CONFLICT" });
    expect(
      await readFile(path.join(root, DESIGN_DIRECTORY_NAME, frame), "utf8"),
    ).toContain("Human draft wins");

    const refreshed = await manager.open(capability.token);
    expect(refreshed.revision).toBe(humanResult.revision);
  });

  it("does not let caller-supplied revisions bypass the capability revision", async () => {
    const manager = new DesignAgentCapabilityManager({ now: () => now });
    const capability = await grant(manager);
    const human = getWorkspaceDesignApi(root);
    const humanResult = await human.apply({
      ...transaction({ id: "human-newer", baseRevision: revision }),
      actor: { kind: "human" as const, id: "designer" },
      operations: [
        {
          operationId: "human-newer-text",
          type: "node.set-text" as const,
          nodeId,
          text: "Human revision remains authoritative",
        },
      ],
    });

    await expect(
      manager.readFoundation(capability.token, {
        expectedRevision: humanResult.revision,
      }),
    ).rejects.toMatchObject({ code: "DESIGN_REPOSITORY_CONFLICT" });
    await expect(
      manager.apply(
        capability.token,
        transaction({
          id: "agent-skips-refresh",
          baseRevision: humanResult.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: "DESIGN_REVISION_CONFLICT" });
    expect(
      await readFile(path.join(root, DESIGN_DIRECTORY_NAME, frame), "utf8"),
    ).toContain("Human revision remains authoritative");

    expect((await manager.open(capability.token)).revision).toBe(
      humanResult.revision,
    );
    expect(
      (
        await manager.readFoundation(capability.token, {
          expectedRevision: humanResult.revision,
        })
      ).revision,
    ).toBe(humanResult.revision);
  });

  it("conflicts instead of silently discarding agent history after a human edit", async () => {
    const manager = new DesignAgentCapabilityManager({ now: () => now });
    const capability = await grant(manager);
    const agentResult = await manager.apply(
      capability.token,
      transaction({ id: "agent-before-human", baseRevision: revision }),
    );
    const human = getWorkspaceDesignApi(root);
    await human.apply({
      ...transaction({
        id: "human-after-agent",
        baseRevision: agentResult.revision,
      }),
      actor: { kind: "human" as const, id: "designer" },
      operations: [
        {
          operationId: "human-after-agent-text",
          type: "node.set-text" as const,
          nodeId,
          text: "Human edit after the agent",
        },
      ],
    });

    await expect(manager.undo(capability.token)).rejects.toMatchObject({
      code: "DESIGN_REPOSITORY_CONFLICT",
    });
    expect(
      await readFile(path.join(root, DESIGN_DIRECTORY_NAME, frame), "utf8"),
    ).toContain("Human edit after the agent");
  });

  it("revokes exact runs and never turns an invalid token into ambient authority", async () => {
    const manager = new DesignAgentCapabilityManager({ now: () => now });
    const capability = await grant(manager);
    expect(manager.revoke(capability.token)).toBe(true);
    expect(manager.revoke(capability.token)).toBe(false);
    await expect(manager.open(capability.token)).rejects.toBeInstanceOf(
      DesignAgentCapabilityError,
    );
    await expect(manager.open("0".repeat(64))).rejects.toMatchObject({
      code: "DESIGN_AGENT_CAPABILITY_INVALID",
    });
  });

  it("exposes every granted read action and renews the same hot run explicitly", async () => {
    const manager = new DesignAgentCapabilityManager({ now: () => now });
    const capability = await grant(manager, { ttlMs: 1_000 });

    const foundation = await manager.readFoundation(capability.token);
    expect(foundation).toMatchObject({
      documentId: `frame:${frame}`,
      revision,
    });
    const provenance = await manager.readProvenance(capability.token, {
      nodeId,
      property: "padding",
    });
    expect(provenance.nodeId).toBe(nodeId);

    now += 900;
    const renewed = manager.renew(capability.token, 2_000);
    expect(renewed.token).toBe(capability.token);
    expect(renewed.expiresAt).toBe(now + 2_000);

    now += 1_100;
    expect((await manager.open(capability.token)).revision).toBe(revision);
  });
});
