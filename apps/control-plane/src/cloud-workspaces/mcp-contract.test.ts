import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudCustomizationDocumentSchema, CloudRepositoryMcpSchema, sealCustomization, openCustomization, publicCustomization, customizationDigest, repositoryCustomizationDigest } from "./mcp-contract.js";
import { CloudRepositoryMcpSchema as ProtocolRepositoryMcpSchema } from "../../../../packages/protocol/src/cloud-customization.js";

describe("standalone CP / protocol repository MCP parity", () => {
  const names = ["0canvas", "0", "123tool", "Tool-1_ok", "a".repeat(64), "a".repeat(65), "_tool", "-tool", "tool.name", "tool/name", "", "design-draft", "cloud-computer", "zeros_workspace", "codex_apps", "__proto__", "constructor", "prototype", "秘密"];
  it.each(names)("shares the safe-name decision for %s", name => {
    const servers = [{ name, transport: "http", url: "http://localhost:24193/mcp" }];
    const expected = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) && !["design-draft", "cloud-computer", "zeros_workspace", "codex_apps", "__proto__", "constructor", "prototype"].includes(name);
    expect(ProtocolRepositoryMcpSchema.safeParse(servers).success).toBe(expected);
    expect(CloudRepositoryMcpSchema.safeParse(servers).success).toBe(expected);
  });
  it.each([
    [{ name: "0canvas", transport: "http", url: "http://localhost:24193/mcp" }],
    [{ name: "valid", transport: "stdio", command: "node", args: ["tool.mjs"], env: { TOKEN: "synthetic-value" } }],
    [{ name: "invalid", transport: "stdio", command: "node", env: { TOKEN: "${env:TOKEN}" } }],
    [{ name: "invalid", transport: "http", url: "https://user:password@example.test/mcp" }],
    [{ name: "invalid", transport: "http", url: "https://example.test/mcp?token=value" }],
    [{ name: "invalid", transport: "stdio", command: "node", cwd: "/srv/zeros/workspace/../outside" }],
    [{ name: "invalid", transport: "http", url: "https://example.test/mcp", oauth: {} }],
    [{ name: "invalid", id: randomUUID(), transport: "stdio", command: "node" }],
    [{ name: "duplicate", transport: "stdio", command: "node" }, { name: "duplicate", transport: "stdio", command: "node" }],
  ])("shares accepted-set decisions for %j", servers => {
    expect(CloudRepositoryMcpSchema.safeParse(servers).success).toBe(ProtocolRepositoryMcpSchema.safeParse(servers).success);
  });
});

describe("organization customization contract", () => {
  const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
  const binding = { id: randomUUID(), organizationId: randomUUID(), ownerUserId: randomUUID(), revision: 1, keyVersion: 1 };
  const document = { servers: [{ id: randomUUID(), name: "remote", transport: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer synthetic-test-value" } }], skills: [{ name: "example", content: "# Example\nUse this skill." }], cursorTeamSettings: "disabled" };
  it("binds public metadata without persisting a raw secret-value verifier", () => {
    const rotated = structuredClone(document);
    rotated.servers[0]!.headers.Authorization = "synthetic-rotated-value";
    expect(customizationDigest(document)).toBe(customizationDigest(rotated));
    rotated.servers[0]!.url = "https://mcp.example.test/replaced";
    expect(customizationDigest(document)).not.toBe(customizationDigest(rotated));
  });
  it("keys repository equality to the tenant, actor, lease and key version", () => {
    const digest = repositoryCustomizationDigest(document, binding, keys);
    expect(repositoryCustomizationDigest(document, binding, keys)).toBe(digest);
    for (const changed of [{ organizationId: randomUUID() }, { ownerUserId: randomUUID() }, { id: randomUUID() }])
      expect(repositoryCustomizationDigest(document, { ...binding, ...changed }, keys)).not.toBe(digest);
    expect(repositoryCustomizationDigest({ ...document, skills: [] }, binding, keys)).not.toBe(digest);
    expect(repositoryCustomizationDigest(document, binding, { ...keys, keys: { 1: randomBytes(32).toString("base64url") } })).not.toBe(digest);
  });
  it("encrypts secret maps and binds ciphertext to tenant, actor and revision", () => {
    const envelope = sealCustomization(document, binding, keys);
    expect(JSON.stringify(envelope)).not.toContain("synthetic-test-value");
    expect(openCustomization(envelope, binding, keys)).toEqual(document);
    for (const changed of [{ organizationId: randomUUID() }, { ownerUserId: randomUUID() }, { revision: 2 }])
      expect(() => openCustomization(envelope, { ...binding, ...changed }, keys)).toThrow();
  });
  it("public settings carry opaque secret refs and key names, never values", () => {
    const view = publicCustomization(CloudCustomizationDocumentSchema.parse(document), binding);
    expect(JSON.stringify(view)).not.toContain("synthetic-test-value");
    expect(view.servers[0]).toMatchObject({ secretRef: document.servers[0]!.id, headerKeys: ["Authorization"] });
  });
  it.each([{ name: "design-draft", transport: "stdio", command: "false" }, { name: "remote", transport: "http", url: "https://user:secret@example.test/mcp" }, { name: "remote", transport: "http", url: "https://example.test/mcp", oauth: {} }])("rejects unadmitted MCP configuration", server => {
    expect(CloudCustomizationDocumentSchema.safeParse({ ...document, servers: [{ id: randomUUID(), ...server }] }).success).toBe(false);
  });
});

it("scopes history encryption keys to an organization/workspace and owner identity to the actor across rotations", async () => {
  const {customizationHistoryAuthority}=await import('./mcp-contract.js');
  const keys={keys:{1:randomBytes(32).toString('base64url')},currentKeyVersion:1};
  const original=customizationHistoryAuthority('org','workspace','member-a',keys);
  const another=customizationHistoryAuthority('org','workspace','member-b',keys);
  expect(original.owner).not.toBe(another.owner); expect(original.keys).toEqual(another.keys);
  expect(customizationHistoryAuthority('other-org','workspace','member-a',keys).keys).not.toEqual(original.keys);
  expect(customizationHistoryAuthority('org','other-workspace','member-a',keys).keys).not.toEqual(original.keys);
  const rotated=customizationHistoryAuthority('org','workspace','member-a',{keys:{...keys.keys,2:randomBytes(32).toString('base64url')},currentKeyVersion:2});
  expect(rotated.owner).toBe(original.owner); expect(rotated.keys['1']).toBe(original.keys['1']); expect(rotated.currentKeyVersion).toBe(2);
  expect(Object.values(original.keys)).not.toContain(keys.keys[1]);
});
