import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "../db.js";
import * as Contract from "./mcp-contract.js";
import * as Admission from "./mcp-admission.js";
import { CloudCustomizationSnapshotSchema as ProtocolSnapshot } from "../../../../packages/protocol/src/cloud-customization.js";

const store = vi.hoisted(() => ({ rows: [] as import("./customization-store.js").CustomizationRow[], lock: vi.fn() }));
vi.mock("./customization-store.js", async original => ({
  ...await original<typeof import("./customization-store.js")>(),
  lockCustomization: store.lock, readCustomizationRows: vi.fn(async (_tx, org: string, actor: string) =>
    store.rows.filter(row => row.org_id === org && (row.owner_user_id === null || row.owner_user_id === actor))),
}));
afterEach(() => { vi.clearAllMocks(); store.rows = []; });

function fixture() {
  const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
  const binding = { contextId: randomUUID(), organizationId: randomUUID(), workspaceId: randomUUID(), generation: 7,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 2,
    actorSessionId: randomUUID(), actorUserId: randomUUID(), actorDeviceId: randomUUID(), actorDeviceKeyVersion: 3,
    actorFingerprint: "a".repeat(64), authorityEpoch: 4, fundingGrant: { kind: "share" as const, grantId: randomUUID(), grantRevision: 5 },
    provider: "claude" as const, conversationId: "conversation", model: "qualified-model", cwd: "/srv/zeros/workspace/tools" };
  const repository: Contract.CloudMcpServer[] = [{ name: "0canvas", transport: "http", url: "http://localhost:24193/mcp" },
    { name: "replace", transport: "stdio", command: "node", cwd: "/srv/zeros/workspace/tools" }];
  const query = vi.fn(async () => ({ rows: [] }));
  const tx = { query } as unknown as Tx;
  function row(owner: string | null, revision: number, document: Contract.CloudCustomizationDocument) {
    const id = randomUUID(), envelope = Contract.sealCustomization(document,
      { id, organizationId: binding.organizationId, ownerUserId: owner, revision, keyVersion: 1 }, keys);
    return { id, org_id: binding.organizationId, owner_user_id: owner, revision: String(revision), key_version: 1,
      nonce: envelope.nonce, ciphertext: envelope.ciphertext, auth_tag: envelope.authTag };
  }
  store.rows = [row(null, 6, { servers: [{ id: randomUUID(), name: "replace", transport: "http", url: "https://example.test/mcp", headers: { Authorization: "synthetic-org-value" } }],
    skills: [{ name: "org-skill", content: "# Organization skill" }], cursorTeamSettings: "disabled" }),
  row(binding.actorUserId, 8, { servers: [{ id: randomUUID(), name: "member-only", transport: "stdio", command: "node", env: { TOKEN: "synthetic-member-value" } }],
    skills: [], cursorTeamSettings: "disabled" })];
  return { binding, repository, keys, tx, query };
}

describe("real boot actor customization context", () => {
  it("materializes actor/repository snapshots without a fabricated lease or writes", async () => {
    const f = fixture(); const admitted = await Admission.admitBootCustomization(f.tx, f.binding, f.repository, f.keys);
    expect(admitted).toMatchObject({ binding: f.binding, organizationRevision: 6, memberRevision: 8, keyVersion: 1 });
    expect(ProtocolSnapshot.parse(admitted.snapshot)).toEqual(admitted.snapshot);
    expect(admitted.snapshot.servers.filter(value => value.scope === "repository").map(value => value.server)).toEqual(f.repository);
    expect(admitted.snapshot.servers.find(value => value.server.name === "replace")?.server).not.toHaveProperty("headers");
    expect(admitted.snapshot.servers.find(value => value.server.name === "member-only")?.server).toHaveProperty("env.TOKEN", "synthetic-member-value");
    expect(JSON.stringify(admitted.envelope)).not.toContain("synthetic-member-value");
    expect(f.query).not.toHaveBeenCalled(); expect(store.lock).toHaveBeenCalledWith(f.tx, f.binding.organizationId);
  });
  it("reopens the exact stored real context only while current customization revisions match", async () => {
    const f = fixture(); const admitted = await Admission.admitBootCustomization(f.tx, f.binding, f.repository, f.keys);
    const snapshot = await Admission.validateBootCustomization(f.tx, f.binding, admitted, f.repository, f.keys);
    expect(snapshot).toEqual(admitted.snapshot);
    store.rows[1]!.revision = "9";
    await expect(Admission.validateBootCustomization(f.tx, f.binding, admitted, f.repository, f.keys))
      .rejects.toMatchObject({ status: 403, code: "cloud_customization_changed" });
  });
  it.each(["contextId", "workspaceId", "bootId", "writerEpoch", "actorSessionId", "actorUserId", "actorDeviceId"])("binds encrypted material to %s", async field => {
    const f = fixture(); const admitted = await Admission.admitBootCustomization(f.tx, f.binding, f.repository, f.keys);
    const changed = { ...f.binding, [field]: randomUUID() };
    expect(() => Contract.openBootCustomization(admitted.envelope, changed, admitted.keyVersion, f.keys)).toThrow();
    await expect(Admission.validateBootCustomization(f.tx, changed, admitted, f.repository, f.keys))
      .rejects.toMatchObject({ status: 403, code: "cloud_customization_changed" });
  });
  it.each(["generation", "fundingOwnerEpoch", "actorDeviceKeyVersion", "authorityEpoch"])("binds encrypted material to real %s", async field => {
    const f = fixture(); const admitted = await Admission.admitBootCustomization(f.tx, f.binding, f.repository, f.keys);
    expect(() => Contract.openBootCustomization(admitted.envelope, { ...f.binding, [field]: 99 }, admitted.keyVersion, f.keys)).toThrow();
  });
  it("binds provider, conversation, cwd, model and the actual consent grant", async () => {
    const f = fixture(); const admitted = await Admission.admitBootCustomization(f.tx, f.binding, f.repository, f.keys);
    for (const change of [{ provider: "cursor" }, { conversationId: "sibling" }, { cwd: "/srv/zeros/workspace/sibling" },
      { model: "other-model" }, { fundingGrant: { ...f.binding.fundingGrant, grantRevision: 6 } }, { actorFingerprint: "b".repeat(64) }])
      expect(() => Contract.openBootCustomization(admitted.envelope, { ...f.binding, ...change }, admitted.keyVersion, f.keys)).toThrow();
    expect(() => Contract.openCustomization(admitted.envelope,
      { id: f.binding.contextId, organizationId: f.binding.organizationId, ownerUserId: f.binding.actorUserId, revision: 1, keyVersion: 1 }, f.keys)).toThrow();
  });
  it("rejects changed repository secret values, sibling sets and snapshot/digest corruption", async () => {
    const f = fixture(); const admitted = await Admission.admitBootCustomization(f.tx, f.binding, f.repository, f.keys);
    for (const repository of [f.repository.slice(1), [{ name: "0canvas", transport: "http", url: "https://other.example.test/mcp" }]])
      await expect(Admission.validateBootCustomization(f.tx, f.binding, admitted, repository, f.keys)).rejects.toMatchObject({ code: "cloud_customization_changed" });
    const replaced = { ...admitted, snapshot: { ...admitted.snapshot, digest: "b".repeat(64) }, digest: "b".repeat(64) };
    await expect(Admission.validateBootCustomization(f.tx, f.binding, replaced, f.repository, f.keys)).rejects.toMatchObject({ code: "cloud_customization_changed" });
  });
  it("keeps the sending actor's private history distinct from funding owner or a sibling member", async () => {
    const f = fixture(); const first = await Admission.admitBootCustomization(f.tx, f.binding, f.repository, f.keys);
    const second = await Admission.admitBootCustomization(f.tx, { ...f.binding, contextId: randomUUID(), actorUserId: randomUUID() }, f.repository, f.keys);
    expect(first.snapshot.history?.owner).not.toBe(second.snapshot.history?.owner);
    expect(second.snapshot.servers.some(value => value.server.name === "member-only")).toBe(false);
    expect(first.snapshot.history?.owner).not.toBe(Contract.customizationHistoryAuthority(f.binding.organizationId, f.binding.workspaceId, f.binding.fundingOwnerUserId, f.keys).owner);
  });
  it("keeps strict CP snapshot acceptance in parity without importing the protocol at runtime", async () => {
    const f = fixture(); const admitted = await Admission.admitBootCustomization(f.tx, f.binding, f.repository, f.keys);
    for (const value of [admitted.snapshot, { ...admitted.snapshot, extra: true }, { ...admitted.snapshot, digest: "bad" },
      { ...admitted.snapshot, servers: [{ ...admitted.snapshot.servers[0], server: { ...admitted.snapshot.servers[0]!.server, id: undefined } }] },
      { ...admitted.snapshot, servers: [{ ...admitted.snapshot.servers[0], server: { name: "excluded", transport: "http", url: "https://example.test/mcp", oauth: {} } }] }])
      expect(Contract.CloudBootCustomizationSnapshotSchema.safeParse(value).success).toBe(ProtocolSnapshot.safeParse(value).success);
  });
});
