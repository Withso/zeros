import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import {
  openCloudWorkspaceSetupSecret,
  sealCloudWorkspaceSetupSecret,
} from "./setup-materials.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_NODES = 20_000;
const MAX_DEPTH = 32;
const MAX_SETUP_COMMANDS = 32;
const MAX_SECRET_BYTES = 64 * 1024;

type JsonScalar = string | number | boolean | null;
export type JsonValue =
  | JsonScalar
  | JsonValue[]
  | { [key: string]: JsonValue };

export type CloudWorkspaceSettingsDocument = {
  values?: Record<string, unknown>;
  secretRefs?: Array<{ id: string; name: string }>;
  setupCommands?: Array<{ command: string; timeoutSeconds: number }>;
};

export type CloudWorkspaceSettingsLayer = {
  source: string;
  document: unknown;
};

export type ResolvedCloudWorkspaceSettings = {
  snapshot: {
    schemaVersion: 1;
    values: Record<string, JsonValue>;
    secretRefs?: Array<{ id: string; name: string }>;
    setupCommands?: Array<{ command: string; timeoutSeconds: number }>;
  };
  provenance: Record<string, string>;
  canonicalJson: string;
  sha256: string;
};

export type NormalizedCloudWorkspaceSettingsDocument = {
  document: CloudWorkspaceSettingsDocument;
  canonicalJson: string;
  sha256: string;
};

export type CloudWorkspaceSetupSecretMaterial = {
  id: string;
  name: string;
  keyVersion: 1;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
};

export type DatabaseResolvedCloudWorkspaceSettings = {
  resolved: ResolvedCloudWorkspaceSettings;
  sourceVersions: Record<string, JsonValue>;
  environmentProfileId: string | null;
  environmentProfileVersion: number | null;
  managedPolicyVersion: number | null;
  setupSecrets: CloudWorkspaceSetupSecretMaterial[];
};

function invalid(): Error {
  return new Error("cloud workspace settings are invalid");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pointerComponent(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function safeCloudEnvironmentName(name: string): boolean {
  return (
    ENVIRONMENT_NAME_PATTERN.test(name) &&
    !name.startsWith("ZEROS_") &&
    !name.startsWith("CONDUCTOR_") &&
    !name.startsWith("LD_") &&
    !name.startsWith("DYLD_") &&
    !name.startsWith("GIT_") &&
    ![
      "BASH_ENV",
      "ENV",
      "HOME",
      "PATH",
      "NODE_OPTIONS",
      "NODE_PATH",
      "PYTHONSTARTUP",
      "RUBYOPT",
      "PERL5OPT",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ].includes(name)
  );
}

function cloneJson(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH) throw invalid();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJson(entry, state, depth + 1));
  }
  if (!plainRecord(value)) throw invalid();
  const result: Record<string, JsonValue> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (
      key.length < 1 ||
      key.length > 256 ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      throw invalid();
    }
    result[key] = cloneJson(value[key], state, depth + 1);
  }
  return result;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`)
    .join(",")}}`;
}

function setLeafProvenance(
  value: JsonValue,
  pointer: string,
  source: string,
  provenance: Record<string, string>,
): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    provenance[pointer] = source;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    setLeafProvenance(
      child,
      `${pointer}/${pointerComponent(key)}`,
      source,
      provenance,
    );
  }
}

function mergeValues(
  target: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
  source: string,
  provenance: Record<string, string>,
  pointer = "/values",
): void {
  for (const [key, value] of Object.entries(incoming)) {
    const childPointer = `${pointer}/${pointerComponent(key)}`;
    const existing = target[key];
    if (
      existing !== null &&
      value !== null &&
      plainRecord(existing) &&
      plainRecord(value)
    ) {
      mergeValues(
        existing as Record<string, JsonValue>,
        value as Record<string, JsonValue>,
        source,
        provenance,
        childPointer,
      );
      continue;
    }
    target[key] = value;
    for (const previous of Object.keys(provenance)) {
      if (previous === childPointer || previous.startsWith(`${childPointer}/`)) {
        delete provenance[previous];
      }
    }
    setLeafProvenance(value, childPointer, source, provenance);
  }
}

function parseLayer(layer: CloudWorkspaceSettingsLayer): {
  values: Record<string, JsonValue>;
  secretRefs: Array<{ id: string; name: string }> | undefined;
  setupCommands:
    | Array<{ command: string; timeoutSeconds: number }>
    | undefined;
} {
  if (
    typeof layer.source !== "string" ||
    layer.source.length < 1 ||
    layer.source.length > 160 ||
    !plainRecord(layer.document)
  ) {
    throw invalid();
  }
  const allowed = new Set(["values", "secretRefs", "setupCommands"]);
  if (Object.keys(layer.document).some((key) => !allowed.has(key))) {
    throw invalid();
  }
  const rawValues = layer.document.values ?? {};
  if (!plainRecord(rawValues)) throw invalid();
  const values = cloneJson(rawValues, { nodes: 0 });
  if (!plainRecord(values)) throw invalid();

  let secretRefs: Array<{ id: string; name: string }> | undefined;
  if (layer.document.secretRefs !== undefined) {
    if (
      !Array.isArray(layer.document.secretRefs) ||
      layer.document.secretRefs.length > 128
    ) {
      throw invalid();
    }
    secretRefs = layer.document.secretRefs.map((entry) => {
      if (
        !plainRecord(entry) ||
        Object.keys(entry).sort().join("\0") !== "id\0name" ||
        typeof entry.id !== "string" ||
        !UUID_PATTERN.test(entry.id) ||
        typeof entry.name !== "string" ||
        !safeCloudEnvironmentName(entry.name)
      ) {
        throw invalid();
      }
      return { id: entry.id, name: entry.name };
    });
    if (new Set(secretRefs.map((entry) => entry.name)).size !== secretRefs.length) {
      throw invalid();
    }
  }

  let setupCommands:
    | Array<{ command: string; timeoutSeconds: number }>
    | undefined;
  if (layer.document.setupCommands !== undefined) {
    if (
      !Array.isArray(layer.document.setupCommands) ||
      layer.document.setupCommands.length > MAX_SETUP_COMMANDS
    ) {
      throw invalid();
    }
    setupCommands = layer.document.setupCommands.map((entry) => {
      if (
        !plainRecord(entry) ||
        Object.keys(entry).sort().join("\0") !== "command\0timeoutSeconds" ||
        typeof entry.command !== "string" ||
        entry.command.trim().length < 1 ||
        Buffer.byteLength(entry.command, "utf8") > 16_384 ||
        entry.command.includes("\0") ||
        !Number.isSafeInteger(entry.timeoutSeconds) ||
        Number(entry.timeoutSeconds) < 1 ||
        Number(entry.timeoutSeconds) > 900
      ) {
        throw invalid();
      }
      return {
        command: entry.command,
        timeoutSeconds: Number(entry.timeoutSeconds),
      };
    });
  }
  return { values: values as Record<string, JsonValue>, secretRefs, setupCommands };
}

export function resolveCloudWorkspaceSettingsLayers(
  layers: readonly CloudWorkspaceSettingsLayer[],
): ResolvedCloudWorkspaceSettings {
  if (layers.length < 1 || layers.length > 16) throw invalid();
  const values: Record<string, JsonValue> = Object.create(null);
  const provenance: Record<string, string> = Object.create(null);
  const secretRefs = new Map<string, { id: string; name: string }>();
  let setupCommands:
    | Array<{ command: string; timeoutSeconds: number }>
    | undefined;

  for (const layer of layers) {
    const parsed = parseLayer(layer);
    mergeValues(values, parsed.values, layer.source, provenance);
    if (parsed.secretRefs !== undefined) {
      for (const reference of parsed.secretRefs) {
        secretRefs.set(reference.name, reference);
        provenance[`/secretRefs/${pointerComponent(reference.name)}`] =
          layer.source;
      }
    }
    if (parsed.setupCommands !== undefined) {
      setupCommands = parsed.setupCommands;
      provenance["/setupCommands"] = layer.source;
    }
  }

  const orderedSecretRefs = [...secretRefs.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const snapshot = {
    schemaVersion: 1 as const,
    values,
    ...(orderedSecretRefs.length > 0 ? { secretRefs: orderedSecretRefs } : {}),
    ...(setupCommands !== undefined ? { setupCommands } : {}),
  };
  const canonicalJson = canonicalize(snapshot as unknown as JsonValue);
  if (Buffer.byteLength(canonicalJson, "utf8") > MAX_DOCUMENT_BYTES) {
    throw invalid();
  }
  return {
    snapshot,
    provenance,
    canonicalJson,
    sha256: createHash("sha256").update(canonicalJson).digest("hex"),
  };
}

/** Validate one persisted settings layer and return its stable representation.
 * The execution-only `schemaVersion` wrapper is deliberately omitted because
 * repository/profile documents are layers, not materialized snapshots. */
export function normalizeCloudWorkspaceSettingsDocument(
  document: unknown,
): NormalizedCloudWorkspaceSettingsDocument {
  const resolved = resolveCloudWorkspaceSettingsLayers([
    { source: "settings management", document },
  ]);
  const normalized: CloudWorkspaceSettingsDocument = {
    values: resolved.snapshot.values,
    ...(resolved.snapshot.secretRefs
      ? { secretRefs: resolved.snapshot.secretRefs }
      : {}),
    ...(resolved.snapshot.setupCommands
      ? { setupCommands: resolved.snapshot.setupCommands }
      : {}),
  };
  const canonicalJson = canonicalize(normalized as unknown as JsonValue);
  return {
    document: normalized,
    canonicalJson,
    sha256: createHash("sha256").update(canonicalJson).digest("hex"),
  };
}

function decodePointerComponent(value: string): string {
  if (/~(?:[^01]|$)/.test(value)) throw invalid();
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function allowedValuePath(path: unknown): string[] {
  if (
    typeof path !== "string" ||
    path.length < 9 ||
    path.length > 1_024 ||
    !path.startsWith("/values/")
  ) {
    throw invalid();
  }
  const components = path
    .slice(1)
    .split("/")
    .map(decodePointerComponent);
  if (
    components[0] !== "values" ||
    components.length < 2 ||
    components.some(
      (component) =>
        component.length < 1 ||
        component.length > 256 ||
        ["__proto__", "constructor", "prototype"].includes(component),
    )
  ) {
    throw invalid();
  }
  return components.slice(1);
}

/** Copy only explicitly consented `/values/...` JSON-pointer subtrees. Secret
 * references and setup commands are intentionally never inherited across an
 * organization boundary. */
export function filterCloudWorkspaceSettingsByAllowedPaths(
  document: unknown,
  allowedPaths: unknown,
): CloudWorkspaceSettingsDocument {
  if (
    !plainRecord(document) ||
    !Array.isArray(allowedPaths) ||
    allowedPaths.length > 64
  ) {
    throw invalid();
  }
  const parsed = parseLayer({ source: "consented profile", document });
  const result: Record<string, JsonValue> = Object.create(null);
  for (const rawPath of allowedPaths) {
    const path = allowedValuePath(rawPath);
    let source: JsonValue | undefined = parsed.values;
    for (const component of path) {
      if (!plainRecord(source) || !(component in source)) {
        source = undefined;
        break;
      }
      source = source[component];
    }
    if (source === undefined) continue;

    let target = result;
    for (const component of path.slice(0, -1)) {
      const current = target[component];
      if (!plainRecord(current)) {
        target[component] = Object.create(null) as Record<string, JsonValue>;
      }
      target = target[component] as Record<string, JsonValue>;
    }
    target[path[path.length - 1]!] = cloneJson(source, { nodes: 0 });
  }
  return { values: result };
}

function secretEnvelopeKey(encodedKey: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) {
    throw new Error("cloud workspace secret key must be 32-byte base64url");
  }
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encodedKey) {
    key.fill(0);
    throw new Error("cloud workspace secret key must be canonical base64url");
  }
  return key;
}

function secretBindingAad(input: {
  bindingId: string;
  organizationId: string;
  version: number;
  name: string;
}): Buffer {
  return Buffer.from(
    [
      "zeros-cloud-secret-binding-v1",
      input.organizationId,
      input.bindingId,
      String(input.version),
      input.name,
    ].join("\0"),
    "utf8",
  );
}

function validSecretBinding(input: {
  bindingId: string;
  organizationId: string;
  version: number;
  name: string;
}): boolean {
  return (
    UUID_PATTERN.test(input.bindingId) &&
    UUID_PATTERN.test(input.organizationId) &&
    Number.isSafeInteger(input.version) &&
    input.version > 0 &&
    safeCloudEnvironmentName(input.name)
  );
}

/** Encryption seam used by a future settings API and by import workers. The
 * plaintext never enters a settings document or an audit payload. */
export function sealCloudWorkspaceSecretBinding(
  value: string,
  binding: {
    bindingId: string;
    organizationId: string;
    version: number;
    name: string;
  },
  encodedKey: string,
): {
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  valueSha256: Buffer;
} {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES ||
    value.includes("\0") ||
    !validSecretBinding(binding)
  ) {
    throw new Error("cloud workspace secret binding input is invalid");
  }
  const key = secretEnvelopeKey(encodedKey);
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(secretBindingAad(binding));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return {
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag(),
      valueSha256: createHash("sha256").update(value, "utf8").digest(),
    };
  } finally {
    key.fill(0);
  }
}

function openCloudWorkspaceSecretBinding(
  sealed: {
    keyVersion: number;
    nonce: Buffer;
    ciphertext: Buffer;
    authTag: Buffer;
    valueSha256: Buffer;
  },
  binding: {
    bindingId: string;
    organizationId: string;
    version: number;
    name: string;
  },
  encodedKey: string,
): string {
  if (
    sealed.keyVersion !== 1 ||
    sealed.nonce.length !== 12 ||
    sealed.authTag.length !== 16 ||
    sealed.valueSha256.length !== 32 ||
    sealed.ciphertext.length < 1 ||
    sealed.ciphertext.length > MAX_SECRET_BYTES ||
    !validSecretBinding(binding)
  ) {
    throw new Error("cloud workspace secret binding is invalid");
  }
  const key = secretEnvelopeKey(encodedKey);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce);
    decipher.setAAD(secretBindingAad(binding));
    decipher.setAuthTag(sealed.authTag);
    const value = Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const digest = createHash("sha256").update(value, "utf8").digest();
    if (
      Buffer.byteLength(value, "utf8") < 1 ||
      Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES ||
      value.includes("\0") ||
      !timingSafeEqual(digest, sealed.valueSha256)
    ) {
      throw new Error("cloud workspace secret binding is invalid");
    }
    return value;
  } catch {
    throw new Error("cloud workspace secret binding is invalid");
  } finally {
    key.fill(0);
  }
}

type ProfileRow = {
  id: string;
  version: string | number;
  document: unknown;
};

type VersionedDocumentRow = {
  version: string | number;
  document: unknown;
};

function positiveVersion(value: string | number): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("cloud workspace settings source version is invalid");
  }
  return version;
}

async function loadDefaultProfile(
  tx: Tx,
  input: {
    organizationId: string;
    ownerKind: "user" | "organization";
    ownerUserId: string | null;
  },
): Promise<ProfileRow | null> {
  const result = await tx.query<ProfileRow>(
    `SELECT profile.id, profile.current_version AS version, version.document
     FROM environment_profiles profile
     JOIN environment_profile_versions version
       ON version.profile_id = profile.id
      AND version.org_id = profile.org_id
      AND version.version = profile.current_version
     WHERE profile.org_id = $1
       AND profile.owner_kind = $2::cloud_profile_owner
       AND profile.owner_user_id IS NOT DISTINCT FROM $3::uuid
       AND profile.is_default
       AND profile.placement IN ('cloud', 'both')
       AND profile.deleted_at IS NULL
     ORDER BY profile.updated_at DESC, profile.id
     LIMIT 2`,
    [input.organizationId, input.ownerKind, input.ownerUserId],
  );
  if (result.rows.length > 1) {
    throw new HttpError(
      409,
      "cloud_settings_default_ambiguous",
      "Cloud workspace settings have more than one default profile",
    );
  }
  return result.rows[0] ?? null;
}

async function loadRepositorySettings(
  tx: Tx,
  organizationId: string,
  repositoryId: string,
): Promise<Map<"shared" | "cloud", VersionedDocumentRow>> {
  const result = await tx.query<VersionedDocumentRow & { scope: "shared" | "cloud" }>(
    `SELECT head.scope, head.current_version AS version, version.document
     FROM repository_settings_heads head
     JOIN repository_settings_versions version
       ON version.org_id = head.org_id
      AND version.repository_id = head.repository_id
      AND version.scope = head.scope
      AND version.version = head.current_version
     WHERE head.org_id = $1 AND head.repository_id = $2`,
    [organizationId, repositoryId],
  );
  return new Map(result.rows.map((row) => [row.scope, row]));
}

type SecretBindingRow = {
  id: string;
  name: string;
  current_version: string | number;
  key_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  value_sha256: Buffer;
};

export async function resolveDatabaseCloudWorkspaceSettings(
  tx: Tx,
  input: {
    organizationId: string;
    repositoryId: string;
    workspaceId: string;
    generation: number;
    actorUserId: string;
    isPersonal: boolean;
    setupSecretKeyV1: string | null;
  },
): Promise<DatabaseResolvedCloudWorkspaceSettings> {
  const layers: CloudWorkspaceSettingsLayer[] = [
    { source: "built-in defaults", document: { values: {} } },
  ];
  const sourceVersions: Record<string, JsonValue> = Object.create(null);
  let environmentProfileId: string | null = null;
  let environmentProfileVersion: number | null = null;

  if (input.isPersonal) {
    const profile = await loadDefaultProfile(tx, {
      organizationId: input.organizationId,
      ownerKind: "user",
      ownerUserId: input.actorUserId,
    });
    if (profile) {
      const version = positiveVersion(profile.version);
      layers.push({ source: `personal cloud profile:${profile.id}@${version}`, document: profile.document });
      sourceVersions.personalProfile = { id: profile.id, version };
      environmentProfileId = profile.id;
      environmentProfileVersion = version;
    }
  } else {
    const inherited = await tx.query<
      ProfileRow & { allowed_paths: unknown; consent_id: string }
    >(
      `SELECT profile.id, consent.id AS consent_id,
              consent.personal_profile_version AS version,
              version.document, consent.allowed_paths
       FROM personal_profile_inheritance_consents consent
       JOIN environment_profiles profile
         ON profile.id = consent.personal_profile_id
        AND profile.owner_kind = 'user'
        AND profile.owner_user_id = consent.user_id
        AND profile.placement IN ('cloud', 'both')
        AND profile.deleted_at IS NULL
       JOIN organizations personal_org
         ON personal_org.id = profile.org_id
        AND personal_org.is_personal AND personal_org.deleted_at IS NULL
       JOIN environment_profile_versions version
         ON version.profile_id = consent.personal_profile_id
        AND version.version = consent.personal_profile_version
        AND version.org_id = profile.org_id
       WHERE consent.org_id = $1 AND consent.user_id = $2
         AND consent.state = 'active'
         AND (consent.expires_at IS NULL OR consent.expires_at > now())
       ORDER BY consent.consented_at, consent.id
       LIMIT 8`,
      [input.organizationId, input.actorUserId],
    );
    const inheritedSources: JsonValue[] = [];
    for (const profile of inherited.rows) {
      const version = positiveVersion(profile.version);
      layers.push({
        source: `consented personal profile:${profile.id}@${version}`,
        document: filterCloudWorkspaceSettingsByAllowedPaths(
          profile.document,
          profile.allowed_paths,
        ),
      });
      inheritedSources.push({
        consentId: profile.consent_id,
        profileId: profile.id,
        version,
      });
    }
    if (inheritedSources.length > 0) {
      sourceVersions.inheritedPersonalProfiles = inheritedSources;
    }
    const organizationProfile = await loadDefaultProfile(tx, {
      organizationId: input.organizationId,
      ownerKind: "organization",
      ownerUserId: null,
    });
    if (organizationProfile) {
      const version = positiveVersion(organizationProfile.version);
      layers.push({
        source: `organization cloud profile:${organizationProfile.id}@${version}`,
        document: organizationProfile.document,
      });
      sourceVersions.organizationProfile = {
        id: organizationProfile.id,
        version,
      };
      environmentProfileId = organizationProfile.id;
      environmentProfileVersion = version;
    }
  }

  const repository = await loadRepositorySettings(
    tx,
    input.organizationId,
    input.repositoryId,
  );
  for (const scope of ["shared", "cloud"] as const) {
    const row = repository.get(scope);
    if (!row) continue;
    const version = positiveVersion(row.version);
    layers.push({
      source: `repository ${scope}:${input.repositoryId}@${version}`,
      document: row.document,
    });
    sourceVersions[`repository${scope === "shared" ? "Shared" : "Cloud"}`] =
      version;
  }

  const policy = await tx.query<VersionedDocumentRow>(
    `SELECT head.current_version AS version, version.document
     FROM organization_cloud_policy_heads head
     JOIN organization_cloud_policy_versions version
       ON version.org_id = head.org_id AND version.version = head.current_version
     WHERE head.org_id = $1`,
    [input.organizationId],
  );
  const policyRow = policy.rows[0];
  let managedPolicyVersion: number | null = null;
  if (policyRow) {
    managedPolicyVersion = positiveVersion(policyRow.version);
    layers.push({
      source: `managed policy:${managedPolicyVersion}`,
      document: policyRow.document,
    });
    sourceVersions.managedPolicy = managedPolicyVersion;
  }

  const merged = resolveCloudWorkspaceSettingsLayers(layers);
  const references = merged.snapshot.secretRefs ?? [];
  const setupSecrets: CloudWorkspaceSetupSecretMaterial[] = [];
  let resolved = merged;
  if (references.length > 0) {
    if (!input.setupSecretKeyV1) {
      throw new HttpError(
        503,
        "cloud_secret_material_not_configured",
        "Cloud workspace secret material is not configured",
      );
    }
    const bindings = await tx.query<SecretBindingRow>(
      `SELECT binding.id, binding.name, binding.current_version,
              version.key_version, version.nonce, version.ciphertext,
              version.auth_tag, version.value_sha256
       FROM secret_bindings binding
       JOIN secret_binding_versions version
         ON version.binding_id = binding.id
        AND version.org_id = binding.org_id
        AND version.version = binding.current_version
       WHERE binding.org_id = $1
         AND binding.id = ANY($2::uuid[])
         AND binding.state = 'active'
         AND binding.purpose = 'environment'
         AND binding.placement IN ('cloud', 'both')
         AND (
           ($3::boolean AND binding.owner_kind = 'user'
             AND binding.owner_user_id = $4)
           OR
           (NOT $3::boolean AND binding.owner_kind = 'organization'
             AND binding.owner_user_id IS NULL)
         )`,
      [
        input.organizationId,
        references.map((reference) => reference.id),
        input.isPersonal,
        input.actorUserId,
      ],
    );
    const byId = new Map(bindings.rows.map((row) => [row.id, row]));
    if (
      byId.size !== references.length ||
      references.some((reference) => byId.get(reference.id)?.name !== reference.name)
    ) {
      throw new HttpError(
        409,
        "cloud_secret_scope_invalid",
        "A cloud workspace secret reference is unavailable in this scope",
      );
    }

    const setupReferences: Array<{ id: string; name: string }> = [];
    const bindingSources: Record<string, JsonValue> = Object.create(null);
    for (const reference of references) {
      const binding = byId.get(reference.id)!;
      const version = positiveVersion(binding.current_version);
      const plaintext = openCloudWorkspaceSecretBinding(
        {
          keyVersion: binding.key_version,
          nonce: binding.nonce,
          ciphertext: binding.ciphertext,
          authTag: binding.auth_tag,
          valueSha256: binding.value_sha256,
        },
        {
          bindingId: binding.id,
          organizationId: input.organizationId,
          version,
          name: binding.name,
        },
        input.setupSecretKeyV1,
      );
      try {
        const setupId = randomUUID();
        const sealed = sealCloudWorkspaceSetupSecret(
          plaintext,
          {
            id: setupId,
            workspaceId: input.workspaceId,
            organizationId: input.organizationId,
            generation: input.generation,
            name: binding.name,
          },
          input.setupSecretKeyV1,
        );
        setupReferences.push({ id: setupId, name: binding.name });
        setupSecrets.push({
          id: setupId,
          name: binding.name,
          keyVersion: 1,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          authTag: sealed.authTag,
        });
        bindingSources[binding.name] = { id: binding.id, version };
      } finally {
        // JavaScript strings cannot be reliably zeroized. Keep the lifetime
        // bounded to this synchronous re-seal block and never retain/log it.
      }
    }
    sourceVersions.secretBindings = bindingSources;
    const materialized = resolveCloudWorkspaceSettingsLayers([
      {
        source: "materialized settings",
        document: {
          values: merged.snapshot.values,
          secretRefs: setupReferences,
          ...(merged.snapshot.setupCommands
            ? { setupCommands: merged.snapshot.setupCommands }
            : {}),
        },
      },
    ]);
    resolved = { ...materialized, provenance: merged.provenance };
  }

  return {
    resolved,
    sourceVersions,
    environmentProfileId,
    environmentProfileVersion,
    managedPolicyVersion,
    setupSecrets,
  };
}

export async function cloneDatabaseCloudWorkspaceSettingsForRollback(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    sourceGeneration: number;
    targetGeneration: number;
    setupSecretKeyV1: string | null;
  },
): Promise<DatabaseResolvedCloudWorkspaceSettings> {
  const source = await tx.query<{
    effective_document: unknown;
    provenance: unknown;
    source_versions: unknown;
    environment_profile_id: string | null;
    environment_profile_version: string | number | null;
    managed_policy_version: string | number | null;
  }>(
    `SELECT effective_document, provenance, source_versions,
            environment_profile_id, environment_profile_version,
            managed_policy_version
     FROM workspace_settings_versions
     WHERE workspace_id = $1 AND org_id = $2 AND generation = $3`,
    [input.workspaceId, input.organizationId, input.sourceGeneration],
  );
  const row = source.rows[0];
  if (
    !row ||
    !plainRecord(row.effective_document) ||
    row.effective_document.schemaVersion !== 1 ||
    Object.keys(row.effective_document).some(
      (key) =>
        !["schemaVersion", "values", "secretRefs", "setupCommands"].includes(
          key,
        ),
    ) ||
    !plainRecord(row.provenance) ||
    !plainRecord(row.source_versions)
  ) {
    throw new HttpError(
      409,
      "cloud_rollback_settings_invalid",
      "Rollback settings snapshot is unavailable",
    );
  }
  const provenance: Record<string, string> = Object.create(null);
  for (const [path, sourceName] of Object.entries(row.provenance)) {
    if (
      !path.startsWith("/") ||
      path.length > 1_024 ||
      typeof sourceName !== "string" ||
      sourceName.length < 1 ||
      sourceName.length > 160
    ) {
      throw new HttpError(
        409,
        "cloud_rollback_settings_invalid",
        "Rollback settings provenance is invalid",
      );
    }
    provenance[path] = sourceName;
  }
  const sourceVersions = cloneJson(row.source_versions, { nodes: 0 });
  if (!plainRecord(sourceVersions)) {
    throw new HttpError(
      409,
      "cloud_rollback_settings_invalid",
      "Rollback settings sources are invalid",
    );
  }
  sourceVersions.rollbackOfGeneration = input.sourceGeneration;

  const sourceDocument: CloudWorkspaceSettingsDocument = {
    values: row.effective_document.values as Record<string, unknown>,
    ...(row.effective_document.secretRefs !== undefined
      ? { secretRefs: row.effective_document.secretRefs as Array<{ id: string; name: string }> }
      : {}),
    ...(row.effective_document.setupCommands !== undefined
      ? {
          setupCommands: row.effective_document.setupCommands as Array<{
            command: string;
            timeoutSeconds: number;
          }>,
        }
      : {}),
  };
  const parsed = resolveCloudWorkspaceSettingsLayers([
    { source: "rollback snapshot", document: sourceDocument },
  ]);
  const sourceReferences = parsed.snapshot.secretRefs ?? [];
  const setupSecrets: CloudWorkspaceSetupSecretMaterial[] = [];
  let resolved = { ...parsed, provenance };
  if (sourceReferences.length > 0) {
    if (!input.setupSecretKeyV1) {
      throw new HttpError(
        503,
        "cloud_secret_material_not_configured",
        "Cloud workspace secret material is not configured",
      );
    }
    const secrets = await tx.query<{
      id: string;
      name: string;
      key_version: number;
      nonce: Buffer;
      ciphertext: Buffer;
      auth_tag: Buffer;
    }>(
      `SELECT id, name, key_version, nonce, ciphertext, auth_tag
       FROM cloud_workspace_setup_secrets
       WHERE workspace_id = $1 AND org_id = $2 AND generation = $3
         AND id = ANY($4::uuid[])`,
      [
        input.workspaceId,
        input.organizationId,
        input.sourceGeneration,
        sourceReferences.map((reference) => reference.id),
      ],
    );
    const byId = new Map(secrets.rows.map((secret) => [secret.id, secret]));
    if (
      byId.size !== sourceReferences.length ||
      sourceReferences.some(
        (reference) => byId.get(reference.id)?.name !== reference.name,
      )
    ) {
      throw new HttpError(
        409,
        "cloud_rollback_settings_invalid",
        "Rollback secret snapshot is unavailable",
      );
    }
    const targetReferences: Array<{ id: string; name: string }> = [];
    for (const reference of sourceReferences) {
      const secret = byId.get(reference.id)!;
      const plaintext = openCloudWorkspaceSetupSecret(
        secret,
        {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: input.sourceGeneration,
        },
        input.setupSecretKeyV1,
      );
      const id = randomUUID();
      const sealed = sealCloudWorkspaceSetupSecret(
        plaintext,
        {
          id,
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          generation: input.targetGeneration,
          name: reference.name,
        },
        input.setupSecretKeyV1,
      );
      targetReferences.push({ id, name: reference.name });
      setupSecrets.push({
        id,
        name: reference.name,
        keyVersion: 1,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        authTag: sealed.authTag,
      });
    }
    const rebound = resolveCloudWorkspaceSettingsLayers([
      {
        source: "rollback snapshot",
        document: {
          values: parsed.snapshot.values,
          secretRefs: targetReferences,
          ...(parsed.snapshot.setupCommands
            ? { setupCommands: parsed.snapshot.setupCommands }
            : {}),
        },
      },
    ]);
    resolved = { ...rebound, provenance };
  }

  return {
    resolved,
    sourceVersions: sourceVersions as Record<string, JsonValue>,
    environmentProfileId: row.environment_profile_id,
    environmentProfileVersion:
      row.environment_profile_version === null
        ? null
        : positiveVersion(row.environment_profile_version),
    managedPolicyVersion:
      row.managed_policy_version === null
        ? null
        : positiveVersion(row.managed_policy_version),
    setupSecrets,
  };
}

export async function persistDatabaseCloudWorkspaceSettings(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    actorUserId: string;
    settings: DatabaseResolvedCloudWorkspaceSettings;
  },
): Promise<{ id: string; document: string; sha256: string }> {
  const result = await tx.query<{ id: string; sha256: string }>(
    `INSERT INTO workspace_settings_versions (
       workspace_id, generation, org_id, schema_version,
       effective_document, provenance, source_versions,
       environment_profile_id, environment_profile_version,
       managed_policy_version, created_by
     ) VALUES (
       $1, $2, $3, 1, $4::jsonb, $5::jsonb, $6::jsonb,
       $7, $8, $9, $10
     )
     RETURNING id, encode(effective_sha256, 'hex') AS sha256`,
    [
      input.workspaceId,
      input.generation,
      input.organizationId,
      input.settings.resolved.canonicalJson,
      JSON.stringify(input.settings.resolved.provenance),
      JSON.stringify(input.settings.sourceVersions),
      input.settings.environmentProfileId,
      input.settings.environmentProfileVersion,
      input.settings.managedPolicyVersion,
      input.actorUserId,
    ],
  );
  const bindingSources = input.settings.sourceVersions.secretBindings;
  if (bindingSources !== undefined) {
    if (!plainRecord(bindingSources)) {
      throw new Error("cloud workspace secret binding sources are invalid");
    }
    for (const [environmentName, source] of Object.entries(bindingSources)) {
      if (
        !safeCloudEnvironmentName(environmentName) ||
        !plainRecord(source) ||
        typeof source.id !== "string" ||
        !UUID_PATTERN.test(source.id) ||
        !Number.isSafeInteger(source.version) ||
        Number(source.version) < 1
      ) {
        throw new Error("cloud workspace secret binding sources are invalid");
      }
      await tx.query(
        `INSERT INTO cloud_workspace_generation_secret_bindings (
           workspace_id, generation, org_id, binding_id, binding_version,
           environment_name
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.workspaceId,
          input.generation,
          input.organizationId,
          source.id,
          Number(source.version),
          environmentName,
        ],
      );
    }
  }
  return {
    id: result.rows[0]!.id,
    document: input.settings.resolved.canonicalJson,
    sha256: result.rows[0]!.sha256,
  };
}

export async function persistCloudWorkspaceSetupSecrets(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    secrets: readonly CloudWorkspaceSetupSecretMaterial[];
  },
): Promise<void> {
  for (const secret of input.secrets) {
    await tx.query(
      `INSERT INTO cloud_workspace_setup_secrets (
         id, workspace_id, generation, org_id, name, key_version,
         nonce, ciphertext, auth_tag
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        secret.id,
        input.workspaceId,
        input.generation,
        input.organizationId,
        secret.name,
        secret.keyVersion,
        secret.nonce,
        secret.ciphertext,
        secret.authTag,
      ],
    );
  }
}
