import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInitialDeleteCaptureRequest } from "./manage-cloud-initial-delete-capture.js";

describe("initial Delete private request input", () => {
  let directory: string, filename: string;
  const input = () => ({ version: 1, channel: "development", generation: 1, expectedOrganizationSlug: "fixture-org",
    organizationId: randomUUID(), workspaceId: randomUUID(), ownerUserId: randomUUID(), operatorUserId: randomUUID(),
    deleteIntentId: randomUUID(), engineInstanceId: randomUUID(), setupRunId: randomUUID(), bootId: randomUUID(),
    writerEpoch: randomUUID(), allocationLeaseId: randomUUID() });
  beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "initial-delete-input-")); filename = path.join(directory, "request.json"); });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  it("reads a private exact-scope request", async () => {
    const request = input();
    await writeFile(filename, JSON.stringify(request), { mode: 0o600 });
    expect(await readInitialDeleteCaptureRequest(filename)).toEqual(request);
  });
  it("refuses symlinks and public input files", async () => {
    await writeFile(filename, JSON.stringify(input()), { mode: 0o600 });
    const link = path.join(directory, "link.json"); await symlink(filename, link);
    await expect(readInitialDeleteCaptureRequest(link)).rejects.toMatchObject({ code: "ELOOP" });
    await chmod(filename, 0o644);
    await expect(readInitialDeleteCaptureRequest(filename)).rejects.toMatchObject({ code: "initial_delete_request_file_invalid" });
  });
  it.each(["", "x".repeat(16_385)])("refuses empty or oversized input", async value => {
    await writeFile(filename, value, { mode: 0o600 });
    await expect(readInitialDeleteCaptureRequest(filename)).rejects.toMatchObject({ code: "initial_delete_request_file_invalid" });
  });
  it.each(["not-json", JSON.stringify({ ...input(), generation: 2 }), JSON.stringify({ ...input(), allowDataLoss: true })])
    ("refuses malformed or out-of-contract input", async value => {
      await writeFile(filename, value, { mode: 0o600 });
      await expect(readInitialDeleteCaptureRequest(filename)).rejects.toMatchObject({ code: "initial_delete_request_invalid" });
    });
});
