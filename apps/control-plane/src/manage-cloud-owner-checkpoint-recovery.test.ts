import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudOwnerCheckpointRecoverySchema, ownerRecoveryTarget } from "./cloud-owner-checkpoint-recovery-contract.js";
import { readOwnerCheckpointRecoveryRequest } from "./manage-cloud-owner-checkpoint-recovery.js";

const stopIntentId = randomUUID();
const request = {
  version: 1, operationId: randomUUID(), channel: "alpha", organizationId: randomUUID(), expectedOrganizationSlug: "fixture",
  workspaceId: randomUUID(), ownerUserId: randomUUID(), operatorUserId: randomUUID(), sourceGeneration: 2,
  stopIntentId, wakeIntentId: randomUUID(), recoveryId: stopIntentId, requestId: randomUUID(), retirementId: randomUUID(),
  custodyId: randomUUID(), providerResourceId: "bx_23456789", providerAccountScope: "fixture-account", providerLossAttestationId: randomUUID(),
  checkpointId: randomUUID(), checkpointSha256: "a".repeat(64), checkpointContentRevision: 19, checkpointRecordRevision: 2,
  checkpointAt: "2020-01-01T00:00:00.000Z", computerBuildId: randomUUID(), computerConfigId: randomUUID(), runtimeId: `r1-${"b".repeat(64)}`,
  ownerAcknowledgedUnsavedLoss: true, ownerApprovalReference: "Fixture owner accepts newer unsaved work loss",
  reason: "Restore the owner's exact selected durable checkpoint",
};

describe("private owner checkpoint recovery input", () => {
  const directories: string[] = [];
  async function file() {
    const directory = await mkdtemp(path.join(tmpdir(), "owner-recovery-"));
    directories.push(directory);
    return path.join(directory, "request.json");
  }
  afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

  it("reads a complete private request without exposing another channel", async () => {
    const filename = await file();
    await writeFile(filename, JSON.stringify(request), { mode: 0o600 });
    expect(await readOwnerCheckpointRecoveryRequest(filename)).toEqual(request);
  });

  it.each([
    { ownerAcknowledgedUnsavedLoss: false }, { channel: "beta" }, { channel: "production" },
    { recoveryId: randomUUID() }, { wakeIntentId: stopIntentId }, { extraAuthority: true },
    { reason: "short" }, { ownerApprovalReference: "x".repeat(513) },
  ])("refuses incomplete acknowledgement or changed scope %j", change => {
    expect(CloudOwnerCheckpointRecoverySchema.safeParse({ ...request, ...change }).success).toBe(false);
  });

  it.each(["", "{invalid", "x".repeat(16_385)])("refuses empty, invalid and oversized request files", async content => {
    const filename = await file();
    await writeFile(filename, content, { mode: 0o600 });
    await expect(readOwnerCheckpointRecoveryRequest(filename)).rejects.toThrow();
  });

  it("rejects readable-by-others files and symlinks", async () => {
    const filename = await file();
    await writeFile(filename, JSON.stringify(request), { mode: 0o600 });
    await chmod(filename, 0o644);
    await expect(readOwnerCheckpointRecoveryRequest(filename)).rejects.toMatchObject({ code: "owner_recovery_request_file_invalid" });
    await chmod(filename, 0o600);
    await symlink(filename, `${filename}.link`);
    await expect(readOwnerCheckpointRecoveryRequest(`${filename}.link`)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it.skipIf(process.platform === "win32")("rejects a real private FIFO without a writer or abandoned I/O", async () => {
    const filename = await file();
    execFileSync("mkfifo", ["-m", "600", filename]);
    await expect(readOwnerCheckpointRecoveryRequest(filename)).rejects.toMatchObject({ code: "owner_recovery_request_file_invalid" });
  }, 2000);

  it.each(["localhost", "127.0.0.1", "[::1]"])("binds approval to the %s database target and channel without retaining passwords", host => {
    const url = new URL(`postgresql://fixture@${host}:5432/fixture`);
    const target = ownerRecoveryTarget(url.toString(), "alpha");
    expect(target).toMatch(/^[a-f0-9]{64}$/);
    expect(ownerRecoveryTarget(url.toString(), "development")).not.toBe(target);
    url.password = randomUUID();
    expect(ownerRecoveryTarget(url.toString(), "alpha")).toBe(target);
    url.hostname = host === "localhost" ? "127.0.0.1" : "localhost";
    expect(ownerRecoveryTarget(url.toString(), "alpha")).not.toBe(target);
    url.hostname = host;
    url.pathname = "/other";
    expect(ownerRecoveryTarget(url.toString(), "alpha")).not.toBe(target);
  });
});
