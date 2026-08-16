import { beforeEach, describe, expect, it, vi } from "vitest";

const fenceHarness = vi.hoisted(() => ({
  supported: true,
  fence: vi.fn<() => Promise<void>>(),
  unfence: vi.fn<() => Promise<void>>(),
}));

vi.mock("../../files/design-lock", () => ({
  designLockSupported: () => fenceHarness.supported,
}));

vi.mock("../workspace-lock", () => ({
  fenceDesignDirectory: fenceHarness.fence,
  unfenceDesignDirectory: fenceHarness.unfence,
}));

import {
  withDesignDocumentWrite,
  withDesignWorkspaceMutation,
} from "../document-write-lock";

describe("withDesignDocumentWrite", () => {
  beforeEach(() => {
    fenceHarness.supported = true;
    fenceHarness.fence.mockReset().mockResolvedValue(undefined);
    fenceHarness.unfence.mockReset().mockResolvedValue(undefined);
  });

  it("does not install or lower process-independent ACLs around a Design write", async () => {
    const write = vi.fn(async () => "written");

    await expect(withDesignDocumentWrite("/workspace/a", write)).resolves.toBe(
      "written",
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(fenceHarness.unfence).not.toHaveBeenCalled();
    expect(fenceHarness.fence).not.toHaveBeenCalled();
  });

  it("preserves the Design write error without replacing it with ACL state", async () => {
    const writeError = new Error("write failed");

    const failure = await withDesignDocumentWrite("/workspace/c", async () => {
      throw writeError;
    }).catch((error: unknown) => error);

    expect(failure).toBe(writeError);
    expect(fenceHarness.unfence).not.toHaveBeenCalled();
    expect(fenceHarness.fence).not.toHaveBeenCalled();
  });

  it("serializes pointer metadata changes with document mutations", async () => {
    fenceHarness.supported = false;
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const first = withDesignDocumentWrite("/workspace/d", async () => {
      firstEntered();
      await blocker;
    });
    await entered;

    const pointerMutation = vi.fn(async () => undefined);
    const second = withDesignWorkspaceMutation("/workspace/d", pointerMutation);
    await Promise.resolve();
    expect(pointerMutation).not.toHaveBeenCalled();

    release();
    await Promise.all([first, second]);
    expect(pointerMutation).toHaveBeenCalledTimes(1);
  });
});
