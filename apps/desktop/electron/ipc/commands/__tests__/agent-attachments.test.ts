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
      fs.lstat(path.join(untrustedRoot, ".context")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the active project root and reports idempotent writes", async () => {
    await expect(call(args(trustedRoot))).resolves.toMatchObject({
      relativePath: path.join(
        ".context",
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

  it("accepts chunked files and resolves their completed path through the same trusted IPC", async () => {
    const common = { ...args(trustedRoot), filename: "report.pdf", mimeType: "application/pdf", uploadId: "upload-1", offset: 0, totalBytes: 5 };
    await expect(call({ ...common, base64: "" })).resolves.toMatchObject({ pending: true, bytes: 0 });
    const result = await call(common);
    expect(await fs.readFile(result.absolutePath as string, "utf8")).toBe("hello");
    await expect(call({ ...args(trustedRoot), filename: "report.pdf", mimeType: "application/pdf", base64: "", resolve: true })).resolves.toMatchObject({ relativePath: result.relativePath, skipped: true });
    await expect(call({ ...common, cwd: untrustedRoot, base64: "", resolve: true })).rejects.toThrow(/workspace/);
  });
});
