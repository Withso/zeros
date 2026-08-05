import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const sidecarMock = vi.hoisted(() => ({ root: null as string | null }));
vi.mock("../../../sidecar", () => ({ currentRoot: () => sidecarMock.root }));

import { agentAttachmentWrite } from "../agent-attachments";

const call = (args: Record<string, unknown>) =>
  (
    agentAttachmentWrite as unknown as (
      value: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>
  )(args);

describe("agent_attachment_write", () => {
  let trustedRoot = "";
  let untrustedRoot = "";

  beforeEach(() => {
    trustedRoot = mkdtempSync(path.join(os.tmpdir(), "zeros-att-trusted-"));
    untrustedRoot = mkdtempSync(path.join(os.tmpdir(), "zeros-att-untrusted-"));
    sidecarMock.root = trustedRoot;
  });

  afterEach(async () => {
    sidecarMock.root = null;
    await Promise.all(
      [trustedRoot, untrustedRoot].map((dir) =>
        fs.rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  const args = (cwd: string) => ({
    cwd,
    attachmentId: "att-1",
    base64: Buffer.from("hello").toString("base64"),
    mimeType: "text/plain",
    filename: "notes.txt",
  });

  it("rejects an arbitrary absolute cwd before creating graph directories", async () => {
    await expect(call(args(untrustedRoot))).rejects.toThrow(/workspace/);
    await expect(
      fs.lstat(path.join(untrustedRoot, ".context-graph")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the active project root and reports idempotent writes", async () => {
    await expect(call(args(trustedRoot))).resolves.toMatchObject({
      relativePath: path.join(
        ".context-graph",
        "local",
        "attachments",
        "att-1",
        "notes.txt",
      ),
    });
    await expect(call(args(trustedRoot))).resolves.toMatchObject({
      skipped: true,
    });
  });
});
