import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../git";
import type { AgentSessionToolInput } from "../../agents/session-tools";
import { initializeDesignDocument, DESIGN_DIRECTORY_NAME } from "../document";
import {
  resolveCodeDesignTarget,
  DesignCodeToolAdmissions,
} from "../code-tool-admission";

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
    await rm(root, { recursive: true, force: true });
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
});
