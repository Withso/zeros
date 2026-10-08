import { createHash, createHmac, hkdfSync } from "node:crypto";
import { z } from "zod";
import { openCredentialBytes, sealCredentialBytes, type CloudAgentCredentialKeys, type CloudAgentCredentialEnvelope } from "./agent-credential-envelope.js";

// Mirrored at the protocol boundary. The backend's deployed Zod 3 build is
// deliberately independent of the desktop/protocol package's Zod 4 runtime.
const text = z.string().max(4096).refine(value => !value.includes("\0") && !/\$\{|\$[A-Za-z_]/.test(value));
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).refine(value =>
  !["design-draft", "cloud-computer", "zeros_workspace", "codex_apps", "__proto__", "constructor", "prototype"].includes(value));
const values = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/), text).refine(value => Object.keys(value).length <= 32);
const url = z.string().max(2048).url().refine(value => {
  const parsed = new URL(value);
  return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
});
const common = { name, id: z.string().uuid().optional() };
export const CloudMcpServerSchema = z.discriminatedUnion("transport", [
  z.object({ ...common, transport: z.literal("stdio"), command: text.pipe(z.string().min(1)), args: z.array(text).max(64).optional(), env: values.optional(),
    cwd: z.string().max(2048).refine(value => value === "/srv/zeros/workspace" || (value.startsWith("/srv/zeros/workspace/") && !value.split("/").includes(".."))).optional() }).strict(),
  z.object({ ...common, transport: z.literal("http"), url, headers: values.optional() }).strict(),
  z.object({ ...common, transport: z.literal("sse"), url, headers: values.optional() }).strict(),
]);
export type CloudMcpServer = z.infer<typeof CloudMcpServerSchema>;
export const CloudRepositoryMcpSchema = z.array(CloudMcpServerSchema).max(32).refine(servers =>
  servers.every(server => !server.id) && new Set(servers.map(server => server.name)).size === servers.length);
export const CloudSkillSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  description: z.string().max(1000).refine(value => !value.includes("\0")).optional(),
  content: z.string().min(1).max(32768).refine(value => !value.includes("\0")) }).strict();
export const CloudCustomizationDocumentSchema = z.object({ servers: z.array(CloudMcpServerSchema).max(32),
  skills: z.array(CloudSkillSchema).max(32), cursorTeamSettings: z.literal("disabled") }).strict().refine(value =>
  value.servers.every(server => !!server.id) && new Set(value.servers.map(server => server.id)).size === value.servers.length &&
  new Set(value.servers.map(server => server.name)).size === value.servers.length && new Set(value.skills.map(skill => skill.name)).size === value.skills.length &&
  Buffer.byteLength(JSON.stringify(value)) <= 192 * 1024);
export type CloudCustomizationDocument = z.infer<typeof CloudCustomizationDocumentSchema>;
export const emptyCustomization = (): CloudCustomizationDocument => ({ servers: [], skills: [], cursorTeamSettings: "disabled" });
export type CustomizationBinding = { id: string; organizationId: string; ownerUserId: string | null; revision: number; keyVersion: number };
const purpose = "zeros-cloud-customization-v1";
function cipherBinding(binding: CustomizationBinding, keys: CloudAgentCredentialKeys) {
  const encoded = keys.keys[binding.keyVersion], root = Buffer.from(encoded ?? "", "base64url");
  if (root.length !== 32 || root.toString("base64url") !== encoded) throw new Error("Customization encryption unavailable");
  try { return { key: Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), purpose, 32)),
    aad: Buffer.from(JSON.stringify([purpose, binding.organizationId, binding.ownerUserId, binding.id, binding.revision, binding.keyVersion])) }; }
  finally { root.fill(0); }
}
export function sealCustomization(value: unknown, binding: CustomizationBinding, keys: CloudAgentCredentialKeys): CloudAgentCredentialEnvelope {
  const { key, aad } = cipherBinding(binding, keys), bytes = Buffer.from(JSON.stringify(value));
  try { return sealCredentialBytes(bytes, aad, key); } finally { key.fill(0); bytes.fill(0); }
}
export function openCustomization(envelope: CloudAgentCredentialEnvelope, binding: CustomizationBinding, keys: CloudAgentCredentialKeys): unknown {
  const { key, aad } = cipherBinding(binding, keys); let bytes: Buffer | undefined;
  try { bytes = openCredentialBytes(envelope, aad, key); return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Customization encryption unavailable"); }
  finally { key.fill(0); bytes?.fill(0); }
}
// Public authority hashes bind secret references/revisions and key names, not
// secret values. Repository equality is instead checked with a keyed verifier
// scoped to the lease, organization, actor and encryption-key version.
export const customizationDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value,
  (key, entry) => (key === "env" || key === "headers") && entry ? Object.keys(entry).sort() : entry)).digest("hex");
export function repositoryCustomizationDigest(value: unknown, binding: CustomizationBinding, keys: CloudAgentCredentialKeys) {
  const { key, aad } = cipherBinding(binding, keys);
  try { return createHmac("sha256", key).update(aad).update("\0repository\0").update(JSON.stringify(value)).digest("hex"); }
  finally { key.fill(0); }
}
/** The engine can decrypt its private redaction history after restart/key
 * rotation. This workspace-specific key never enters a provider or Settings. */
export function customizationHistoryAuthority(organizationId: string, workspaceId: string, actorUserId: string, keys: CloudAgentCredentialKeys) {
  const purpose = "zeros-cloud-customization-history-v1";
  const historyKeys = Object.fromEntries(Object.entries(keys.keys).map(([version, encoded]) => {
    const root = Buffer.from(encoded, "base64url");
    if (root.length !== 32) throw new Error("Customization encryption unavailable");
    try { return [version, Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), JSON.stringify([purpose, organizationId, workspaceId, version]), 32)).toString("base64url")]; }
    finally { root.fill(0); }
  }));
  return { owner: createHash("sha256").update(JSON.stringify([organizationId, actorUserId])).digest("hex"), currentKeyVersion: keys.currentKeyVersion, keys: historyKeys };
}
export function publicCustomization(document: CloudCustomizationDocument, binding: Pick<CustomizationBinding, "revision">) {
  return { revision: binding.revision, cursorTeamSettings: document.cursorTeamSettings, skills: document.skills,
    servers: document.servers.map(server => {
      const { id, ...config } = server;
      const envKeys = server.transport === "stdio" ? Object.keys(server.env ?? {}) : [];
      const headerKeys = server.transport !== "stdio" ? Object.keys(server.headers ?? {}) : [];
      if (config.transport === "stdio") delete config.env; else delete config.headers;
      return { ...config, id: id!, secretRef: envKeys.length || headerKeys.length ? id! : null, envKeys, headerKeys };
    }) };
}
