import { z } from "zod";
import { loadCodexFingerprintKeys, type CodexFingerprintKeys } from "./codex-fingerprint-keys.js";

export const CloudAgentCredentialEnvSchema = z.object({
  CLOUD_WORKSPACE_SECRET_KEY_V1: z.string().trim().min(1).max(256).optional(),
  CLOUD_WORKSPACE_SECRET_KEYS_JSON: z.string().trim().min(2).max(16_384).optional(),
  CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION: z.coerce.number().int().min(1).max(65_535).optional(),
});

export type CloudAgentCredentialConfig = {
  settingsSecretEncryptionKeys: Readonly<Record<number, string>>;
  currentSettingsSecretEncryptionKeyVersion: number | null;
  settingsSecretKeyV1: string | null;
  codexRefreshFingerprints?: CodexFingerprintKeys;
};

export function loadCloudAgentCredentialConfig(env: NodeJS.ProcessEnv): CloudAgentCredentialConfig {
  const parsed = CloudAgentCredentialEnvSchema.safeParse(env);
  if (!parsed.success) throw new Error("Invalid cloud workspace environment: " +
    parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  const value = parsed.data, settingsSecretEncryptionKeys: Record<number, string> = {};
  const addSecretKey = (version: number, encoded: unknown, name: string) => {
    if (!Number.isSafeInteger(version) || version < 1 || version > 65_535 ||
      typeof encoded !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
      throw new Error(`Invalid cloud workspace environment: ${name} must be canonical base64url for exactly 32 bytes`);
    }
    const key = Buffer.from(encoded, "base64url");
    try {
      if (key.length !== 32 || key.toString("base64url") !== encoded) throw new Error("invalid key");
    } catch {
      throw new Error(`Invalid cloud workspace environment: ${name} must be canonical base64url for exactly 32 bytes`);
    } finally { key.fill(0); }
    const current = settingsSecretEncryptionKeys[version];
    if (current && current !== encoded) throw new Error(`Invalid cloud workspace environment: conflicting secret key version ${version}`);
    settingsSecretEncryptionKeys[version] = encoded;
  };
  if (value.CLOUD_WORKSPACE_SECRET_KEYS_JSON) {
    let document: unknown;
    try { document = JSON.parse(value.CLOUD_WORKSPACE_SECRET_KEYS_JSON); }
    catch { throw new Error("Invalid cloud workspace environment: CLOUD_WORKSPACE_SECRET_KEYS_JSON must be a JSON object"); }
    if (!document || typeof document !== "object" || Array.isArray(document) ||
      Object.keys(document).length < 1 || Object.keys(document).length > 32) {
      throw new Error("Invalid cloud workspace environment: CLOUD_WORKSPACE_SECRET_KEYS_JSON must contain 1-32 key versions");
    }
    for (const [rawVersion, encoded] of Object.entries(document)) {
      if (!/^[1-9][0-9]{0,4}$/.test(rawVersion)) {
        throw new Error("Invalid cloud workspace environment: secret key versions must be integers from 1 through 65535");
      }
      addSecretKey(Number(rawVersion), encoded, `CLOUD_WORKSPACE_SECRET_KEYS_JSON.${rawVersion}`);
    }
  }
  if (value.CLOUD_WORKSPACE_SECRET_KEY_V1) addSecretKey(1, value.CLOUD_WORKSPACE_SECRET_KEY_V1, "CLOUD_WORKSPACE_SECRET_KEY_V1");
  const secretKeyVersions = Object.keys(settingsSecretEncryptionKeys).map(Number);
  const currentSettingsSecretEncryptionKeyVersion = value.CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION ??
    (secretKeyVersions.length === 1 && secretKeyVersions[0] === 1 ? 1 : null);
  if (currentSettingsSecretEncryptionKeyVersion !== null && !settingsSecretEncryptionKeys[currentSettingsSecretEncryptionKeyVersion]) {
    throw new Error("Invalid cloud workspace environment: the current secret key version is not present in the keyring");
  }
  if (secretKeyVersions.length > 0 && currentSettingsSecretEncryptionKeyVersion === null) {
    throw new Error("Invalid cloud workspace environment: CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION is required for a multi-version secret keyring");
  }
  const codexRefreshFingerprints = loadCodexFingerprintKeys(env);
  return { settingsSecretEncryptionKeys, currentSettingsSecretEncryptionKeyVersion, settingsSecretKeyV1: settingsSecretEncryptionKeys[1] ?? null,
    ...(codexRefreshFingerprints ? { codexRefreshFingerprints } : {}) };
}
