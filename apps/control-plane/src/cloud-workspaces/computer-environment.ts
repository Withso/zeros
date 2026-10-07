import { randomUUID } from "node:crypto";
import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import { CloudComputerV2EnvironmentOperationSchema } from "./computer-v2-contract.js";
import {
  configuredSecretEncryption,
  filterCloudWorkspaceSettingsByAllowedPaths,
  openCloudWorkspaceSecretBinding,
  resolveCloudWorkspaceSettingsLayers,
  type CloudWorkspaceSettingsLayer,
  type DatabaseResolvedCloudWorkspaceSettings,
  type JsonValue,
  type SecretEncryptionConfiguration,
} from "./settings.js";
import { sealCloudWorkspaceSetupSecret } from "./setup-materials.js";
import { requireSupportedCloudWorkspaceGeneration } from "./supported-generation.js";

type Scope = {
  organizationId: string;
  workspaceId: string;
  generation: number;
};
type Binding = {
  id: string;
  name: string;
  version: string | number;
  available: boolean;
  key_version: number;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  verifier_scheme: number;
  value_verifier: Buffer | null;
};
export type ComputerEnvironmentSource = {
  configId: string;
  bindings: Binding[];
};
const record = (value: unknown): value is Record<string, JsonValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function invalid(): never {
  throw new HttpError(
    422,
    "cloud_settings_invalid",
    "Cloud environment settings are invalid.",
  );
}
function revoked(): never {
  throw new HttpError(
    409,
    "computer_environment_revoked",
    "The Cloud Computer environment is no longer authorized.",
  );
}
function unavailable(): never {
  throw new HttpError(
    409,
    "cloud_settings_snapshot_unavailable",
    "The workspace environment snapshot is unavailable.",
  );
}
async function environmentLocks<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    // Revocation may already hold a binding/consent before acquiring the
    // workspace. Never wait in the inverse order or deliver its old value.
    if ((error as { code?: string } | null)?.code === "55P03")
      throw new HttpError(
        503,
        "computer_environment_busy",
        "Cloud environment authority is changing; retry the request.",
      );
    throw error;
  }
}
function environmentName(name: string) {
  if (
    !CloudComputerV2EnvironmentOperationSchema.safeParse({
      op: "preserve",
      name,
    }).success
  )
    invalid();
}

/** The generation sidecar, never the mutable head/draft/current_version, selects
 * org values. LEFT JOINs deliberately retain a missing or revoked reference. */
export async function loadCloudComputerEnvironmentSource(
  tx: Tx,
  scope: Scope,
): Promise<ComputerEnvironmentSource> {
  const { source } = await requireSupportedCloudWorkspaceGeneration(tx, scope);
  const bindings = (
    await environmentLocks(() =>
      tx.query<Binding>(
        `SELECT ref.binding_id AS id,ref.name,ref.binding_version AS version,
       coalesce(material.available,false) AS available,
       material.key_version,material.nonce,material.ciphertext,material.auth_tag,material.verifier_scheme,material.value_verifier
     FROM cloud_computer_environment_refs ref
     LEFT JOIN LATERAL (
       SELECT (binding.state='active' AND binding.owner_kind='organization' AND binding.owner_user_id IS NULL
         AND binding.purpose='environment' AND binding.placement IN ('cloud','both') AND binding.name=ref.name
         AND version.retired_at IS NULL) AS available,
         version.key_version,version.nonce,version.ciphertext,version.auth_tag,version.verifier_scheme,version.value_verifier
       FROM secret_bindings binding
       JOIN secret_binding_versions version ON version.binding_id=binding.id AND version.org_id=binding.org_id AND version.version=ref.binding_version
       WHERE binding.id=ref.binding_id AND binding.org_id=ref.org_id
       FOR SHARE OF binding,version NOWAIT
     ) material ON true
     WHERE ref.config_id=$1 AND ref.org_id=$2 ORDER BY ref.name`,
        [source.configId, scope.organizationId],
      ),
    )
  ).rows;
  for (const binding of bindings) {
    if (!binding.available) revoked();
    environmentName(binding.name);
  }
  return { configId: source.configId, bindings };
}

/** Only explicitly consented ordinary values cross the personal org boundary.
 * Secret references and setup commands keep the existing non-inheritance rule. */
async function personalEnvironmentLayers(
  tx: Tx,
  scope: Scope,
  actorUserId: string,
): Promise<CloudWorkspaceSettingsLayer[]> {
  const rows = (
    await environmentLocks(() =>
      tx.query<{
        id: string;
        version: string;
        document: unknown;
        allowed_paths: unknown;
      }>(
        `SELECT profile.id,consent.personal_profile_version AS version,version.document,consent.allowed_paths
     FROM personal_profile_inheritance_consents consent
     JOIN environment_profiles profile ON profile.id=consent.personal_profile_id AND profile.owner_kind='user'
       AND profile.owner_user_id=consent.user_id AND profile.placement IN ('cloud','both') AND profile.deleted_at IS NULL
     JOIN organizations personal ON personal.id=profile.org_id AND personal.is_personal AND personal.deleted_at IS NULL
     JOIN environment_profile_versions version ON version.profile_id=profile.id AND version.org_id=profile.org_id
       AND version.version=consent.personal_profile_version
     WHERE consent.org_id=$1 AND consent.user_id=$2 AND consent.state='active'
       AND (consent.expires_at IS NULL OR consent.expires_at>clock_timestamp())
     ORDER BY consent.consented_at,consent.id LIMIT 8 FOR SHARE OF consent,profile,version NOWAIT`,
        [scope.organizationId, actorUserId],
      ),
    )
  ).rows;
  return rows.map((row) => ({
    source: `consented personal profile:${row.id}@${row.version}`,
    document: filterCloudWorkspaceSettingsByAllowedPaths(
      row.document,
      row.allowed_paths,
    ),
  }));
}

type BindingPin = { id: string; version: number };
type EnvironmentEntry = { source: string } & (
  | { value: string }
  | { binding: Binding }
);
async function resolveEnvironment(
  tx: Tx,
  scope: Scope,
  source: ComputerEnvironmentSource,
  layers: CloudWorkspaceSettingsLayer[],
  encryption: SecretEncryptionConfiguration,
  pins?: BindingPin[],
) {
  const selected = new Map<string, EnvironmentEntry>(
    source.bindings.map((binding) => [
      binding.name,
      { binding, source: `Cloud Computer:${source.configId}` },
    ]),
  );
  const normalized = layers.map((layer) => ({
    source: layer.source,
    document: resolveCloudWorkspaceSettingsLayers([layer]).snapshot,
  }));
  const references = normalized.flatMap(
    (layer) => layer.document.secretRefs ?? [],
  );
  const ids = [...new Set(references.map((ref) => ref.id))];
  const bindings = ids.length
    ? (
        await environmentLocks(() =>
          tx.query<Binding>(
            `SELECT binding.id,binding.name,version.version,
       (binding.state='active' AND binding.owner_kind='organization' AND binding.owner_user_id IS NULL
         AND binding.purpose='environment' AND binding.placement IN ('cloud','both') AND version.retired_at IS NULL) AS available,
       version.key_version,version.nonce,version.ciphertext,version.auth_tag,version.verifier_scheme,version.value_verifier
     FROM secret_bindings binding
     JOIN secret_binding_versions version ON version.binding_id=binding.id AND version.org_id=binding.org_id
       AND version.version=CASE WHEN $3::jsonb IS NULL THEN binding.current_version ELSE ($3::jsonb->>binding.id::text)::bigint END
     WHERE binding.org_id=$1 AND binding.id=ANY($2::uuid[]) ORDER BY binding.id FOR SHARE OF binding,version NOWAIT`,
            [
              scope.organizationId,
              ids,
              pins === undefined
                ? null
                : JSON.stringify(
                    Object.fromEntries(
                      pins.map((pin) => [pin.id, pin.version]),
                    ),
                  ),
            ],
          ),
        )
      ).rows
    : [];
  const byId = new Map(bindings.map((binding) => [binding.id, binding]));
  if (
    references.some(
      (ref) =>
        !byId.get(ref.id)?.available || byId.get(ref.id)?.name !== ref.name,
    )
  )
    throw new HttpError(
      409,
      "cloud_secret_scope_invalid",
      "A cloud environment binding is no longer authorized.",
    );
  for (const layer of normalized) {
    const env = layer.document.values.env;
    if (env !== undefined) {
      if (!record(env)) invalid();
      for (const [name, value] of Object.entries(env)) {
        environmentName(name);
        if (
          typeof value !== "string" ||
          value.includes("\0") ||
          Buffer.byteLength(value) > 65_536
        )
          invalid();
        selected.set(name, { value, source: layer.source });
      }
    }
    for (const ref of layer.document.secretRefs ?? []) {
      environmentName(ref.name);
      selected.set(ref.name, {
        binding: byId.get(ref.id)!,
        source: layer.source,
      });
    }
  }
  if (selected.size > 128) invalid();
  const keys = configuredSecretEncryption(encryption).keys;
  const values: Record<string, string> = Object.create(null);
  const bindingSources: Record<string, JsonValue> = Object.create(null);
  const provenance: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const [name, entry] of [...selected].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if ("value" in entry) values[name] = entry.value;
    else {
      const binding = entry.binding;
      values[name] = openCloudWorkspaceSecretBinding(
        {
          keyVersion: binding.key_version,
          nonce: binding.nonce,
          ciphertext: binding.ciphertext,
          authTag: binding.auth_tag,
          verifierScheme: binding.verifier_scheme,
          valueVerifier: binding.value_verifier,
        },
        {
          bindingId: binding.id,
          organizationId: scope.organizationId,
          version: Number(binding.version),
          name,
        },
        keys,
      );
      bindingSources[name] = {
        id: binding.id,
        version: Number(binding.version),
      };
    }
    bytes += Buffer.byteLength(values[name]!);
    provenance[`/secretRefs/${name}`] = entry.source;
  }
  if (
    bytes > 512 * 1024 ||
    Buffer.byteLength(JSON.stringify(values)) > 768 * 1024
  )
    invalid();
  return {
    values,
    bindingSources,
    provenance,
    pins: bindings.map((binding) => ({
      id: binding.id,
      version: Number(binding.version),
    })),
  };
}

/** Generation creation uses the normal encrypted setup-secret envelopes. No
 * org/personal literal is stored in values.env or the managed TOML document. */
export async function materializeCloudComputerSettings(
  tx: Tx,
  input: Scope & SecretEncryptionConfiguration,
  source: ComputerEnvironmentSource,
  base: DatabaseResolvedCloudWorkspaceSettings,
  layers: CloudWorkspaceSettingsLayer[],
  setupCommands: Array<{ command: string; timeoutSeconds: number }>,
) {
  const environment = await resolveEnvironment(
    tx,
    input,
    source,
    layers,
    input,
  );
  const encryption = configuredSecretEncryption(input);
  if (
    Object.keys(environment.values).length &&
    encryption.currentVersion === null
  )
    throw new HttpError(
      503,
      "cloud_secret_material_not_configured",
      "Cloud workspace secret material is not configured.",
    );
  const refs: Array<{ id: string; name: string }> = [],
    setupSecrets: DatabaseResolvedCloudWorkspaceSettings["setupSecrets"] = [];
  for (const [name, value] of Object.entries(environment.values)) {
    // Empty ordinary overrides have no secret bytes to seal. Their pinned
    // repository document/current actor consent still resolves them at every
    // delivery; never substitute the lower-precedence org value.
    if (value === "") continue;
    const id = randomUUID(),
      keyVersion = encryption.currentVersion!;
    const sealed = sealCloudWorkspaceSetupSecret(
      value,
      { ...input, id, name },
      encryption.keys[keyVersion]!,
    );
    refs.push({ id, name });
    setupSecrets.push({ id, name, keyVersion, ...sealed });
  }
  const { env: _env, ...values } = base.resolved.snapshot.values;
  const resolved = resolveCloudWorkspaceSettingsLayers([
    {
      source: "materialized computer settings",
      document: { values, secretRefs: refs, setupCommands },
    },
  ]);
  const provenance = Object.fromEntries(
    Object.entries(base.resolved.provenance).filter(
      ([path]) =>
        !path.startsWith("/values/env/") &&
        path !== "/values/env" &&
        !path.startsWith("/secretRefs/"),
    ),
  );
  return {
    ...base,
    resolved: {
      ...resolved,
      provenance: {
        ...provenance,
        ...environment.provenance,
        "/setupCommands": "repository cloud setup",
      },
    },
    setupSecrets,
    sourceVersions: {
      ...base.sourceVersions,
      secretBindings: environment.bindingSources,
      computerEnvironment: {
        configId: source.configId,
        bindings: environment.pins,
      },
    },
  } satisfies DatabaseResolvedCloudWorkspaceSettings;
}

/** Setup uses its creating actor. Each later turn/terminal resolves its own
 * actor, pinned repo/managed versions, and exact org refs. A draft is never read. */
export async function resolveCloudComputerExecutionEnvironment(
  tx: Tx,
  scope: Scope,
  actorUserId: string,
  encryption: SecretEncryptionConfiguration,
) {
  const source = await loadCloudComputerEnvironmentSource(tx, scope);
  const snapshot = (
    await tx.query<{
      source_versions: Record<string, JsonValue>;
      repository_id: string;
    }>(
      `SELECT settings.source_versions,workspace.repository_id FROM workspace_settings_versions settings
     JOIN cloud_workspaces workspace ON workspace.id=settings.workspace_id AND workspace.org_id=settings.org_id
     WHERE settings.workspace_id=$1 AND settings.generation=$2 AND settings.org_id=$3`,
      [scope.workspaceId, scope.generation, scope.organizationId],
    )
  ).rows[0];
  const metadata = snapshot?.source_versions.computerEnvironment;
  if (
    !snapshot ||
    !record(metadata) ||
    metadata.configId !== source.configId ||
    !Array.isArray(metadata.bindings)
  )
    unavailable();
  const pins = metadata.bindings.map((pin) => {
    if (
      !record(pin) ||
      typeof pin.id !== "string" ||
      !Number.isSafeInteger(pin.version) ||
      Number(pin.version) < 1
    )
      unavailable();
    return { id: pin.id, version: Number(pin.version) };
  });
  const layers: CloudWorkspaceSettingsLayer[] = [];
  for (const name of ["shared", "cloud"] as const) {
    const version =
      snapshot.source_versions[
        name === "shared" ? "repositoryShared" : "repositoryCloud"
      ];
    if (version === undefined) continue;
    if (!Number.isSafeInteger(version) || Number(version) < 1) unavailable();
    const row = (
      await tx.query<{ document: unknown }>(
        `SELECT document FROM repository_settings_versions
      WHERE org_id=$1 AND repository_id=$2 AND scope=$3 AND version=$4`,
        [scope.organizationId, snapshot.repository_id, name, version],
      )
    ).rows[0];
    if (!row) unavailable();
    layers.push({
      source: `repository ${name}:${snapshot.repository_id}@${version}`,
      document: row.document,
    });
  }
  layers.push(...(await personalEnvironmentLayers(tx, scope, actorUserId)));
  const policy = snapshot.source_versions.managedPolicy;
  if (policy !== undefined) {
    if (!Number.isSafeInteger(policy) || Number(policy) < 1) unavailable();
    const row = (
      await tx.query<{ document: unknown }>(
        "SELECT document FROM organization_cloud_policy_versions WHERE org_id=$1 AND version=$2",
        [scope.organizationId, policy],
      )
    ).rows[0];
    if (!row) unavailable();
    layers.push({ source: `managed policy:${policy}`, document: row.document });
  }
  return (await resolveEnvironment(tx, scope, source, layers, encryption, pins))
    .values;
}
