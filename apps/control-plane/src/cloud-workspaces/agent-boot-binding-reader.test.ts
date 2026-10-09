import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Tx } from "../db.js";
import { readCurrentCloudAgentBootBinding } from "./agent-boot-credentials.js";

const scope = { organizationId: randomUUID(), workspaceId: randomUUID() };
const bindingId = randomUUID();
const bindingScope = { ...scope, generation: 1, engineInstanceId: randomUUID(), bootId: randomUUID(),
  writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
const initialAdoptions = [
  { provider: "claude", status: "unknown" }, { provider: "codex", status: "missing" },
  { provider: "cursor", status: "known", adoptionId: randomUUID() },
];
const localRow = () => ({ mode: "boot-owner-v1", pointer: bindingId, hasActivatedWriter: true,
  bindingId, binding: { ...bindingScope }, writer: { ...bindingScope }, engineBootId: bindingScope.bootId,
  writerState: "active", initialized: true, cacheRevision: "1", desiredCacheRevision: "1", initialAdoptions,
  currentFundingOwnerUserId: bindingScope.fundingOwnerUserId, currentFundingOwnerEpoch: "1" });
const fixture = (row: unknown) => ({ query: vi.fn(async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 })) });
const read = (row: unknown, target = scope) => {
  const tx = fixture(row);
  return readCurrentCloudAgentBootBinding(tx as unknown as Tx, target);
};

describe("passive authoritative cloud boot binding", () => {
  it("returns legacy only from an explicit legacy row with no activated writer", async () => {
    await expect(read({ mode: "legacy", pointer: null, hasActivatedWriter: false,
      bindingId: null, binding: null, writer: null, engineBootId: null, writerState: null,
      initialized: null, cacheRevision: null, desiredCacheRevision: null, initialAdoptions: null,
      currentFundingOwnerUserId: bindingScope.fundingOwnerUserId, currentFundingOwnerEpoch: "1" })).resolves.toEqual({ mode: "legacy" });
    await expect(read(null)).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
  });

  it.each(["active", "retired"])("reads the exact %s bound writer without selecting a newer boot", async writerState => {
    await expect(read({ ...localRow(), writerState })).resolves.toEqual({ mode: "boot-owner-v1", binding: {
      id: bindingId, ...bindingScope, fundingScope: "workspace-roles-v1", writerState,
      cacheRevision: 1, desiredCacheRevision: 1, initialAdoptions, status: "current",
    } });
  });

  it.each(["missing", "foreign", "reserved"])("never degrades local %s binding to legacy", async shape => {
    const row = localRow();
    if (shape === "missing") await expect(read({ ...row, pointer: null, bindingId: null, binding: null })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    if (shape === "foreign") await expect(read({ ...row, bindingId: randomUUID() })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    if (shape === "reserved") await expect(read({ ...row, writerState: "reserved" })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
  });

  it.each(["organizationId", "workspaceId", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId"] as const)(
    "refuses a mismatched exact writer %s", async field => {
      const row = localRow();
      await expect(read({ ...row, writer: { ...row.writer, [field]: randomUUID() } })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    },
  );

  it.each(["generation", "fundingOwnerEpoch"] as const)("refuses a mismatched writer %s", async field => {
    const row = localRow();
    await expect(read({ ...row, writer: { ...row.writer, [field]: 2 } })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
  });

  it("refuses a wire boot witness or target scope transplant", async () => {
    await expect(read({ ...localRow(), engineBootId: randomUUID() })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    await expect(read(localRow(), { ...scope, workspaceId: randomUUID() })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    await expect(read(localRow(), { ...scope, organizationId: randomUUID() })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
  });

  it("does not mistake returned-to-A epoch for uninterrupted owner funding", async () => {
    const row = localRow();
    await expect(read({ ...row, currentFundingOwnerUserId: randomUUID(), currentFundingOwnerEpoch: "2" }))
      .resolves.toMatchObject({ binding: { ...bindingScope, status: "owner-changed" } });
    await expect(read({ ...row, currentFundingOwnerEpoch: "3" }))
      .resolves.toMatchObject({ binding: { ...bindingScope, status: "owner-changed" } });
  });

  it("keeps dirty ready revisions as metadata without exposing material", async () => {
    await expect(read({ ...localRow(), desiredCacheRevision: "2" }))
      .resolves.toMatchObject({ binding: { cacheRevision: 1, desiredCacheRevision: 2 } });
    await expect(read({ ...localRow(), cacheRevision: "2", desiredCacheRevision: "1" }))
      .rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    await expect(read({ ...localRow(), initialized: false })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
  });

  it("refuses contradictory legacy rows instead of querying the old queue", async () => {
    await expect(read({ ...localRow(), mode: "legacy" })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    await expect(read({ ...localRow(), mode: "legacy", pointer: null })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    await expect(read({ ...localRow(), mode: "invented" })).rejects.toMatchObject({ code: "cloud_validation_access_denied" });
  });

  it("refuses unsafe revision and malformed immutable baseline metadata", async () => {
    await expect(read({ ...localRow(), cacheRevision: "9007199254740992", desiredCacheRevision: "9007199254740992" }))
      .rejects.toMatchObject({ code: "cloud_validation_access_denied" });
    await expect(read({ ...localRow(), initialAdoptions: [initialAdoptions[0], initialAdoptions[0], initialAdoptions[2]] }))
      .rejects.toMatchObject({ code: "cloud_validation_access_denied" });
  });

  it.each(["0", "9007199254740992", "invalid"])("refuses malformed current funding epoch %s even after an owner change", async currentFundingOwnerEpoch => {
    await expect(read({ ...localRow(), currentFundingOwnerUserId: randomUUID(), currentFundingOwnerEpoch }))
      .rejects.toMatchObject({ code: "cloud_validation_access_denied" });
  });
});
