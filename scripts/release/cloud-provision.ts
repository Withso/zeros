import { z } from "zod";
import { loadConfig } from "../../apps/control-plane/src/config";
import { BoatAccountAdmissionConfigurationSchema } from "../../apps/control-plane/src/cloud-workspaces/boat-account-admission";
import { CHANNELS, ReleaseIdentity, WorkerIdentity, type Channel } from "./contracts";
import { WORKER_TUPLE_KEYS } from "./worker-identity";

export const CLOUD_WORKER_VARIABLES = WORKER_TUPLE_KEYS;
export const CLOUD_OWNER_SECRETS = ["BOAT_API_KEY", "CLOUD_WORKSPACE_S3_ACCESS_KEY_ID",
  "CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY", "RESEND_API_KEY"] as const;
export const CLOUD_CANARY_INPUTS = ["ZEROS_RELEASE_CANARIES_ENABLED", "RUNTIME_QUALIFICATION_ACTOR_USER_ID",
  "WORKER_CANARY_ORGANIZATION_ID", "WORKER_CANARY_REPOSITORY", "WORKER_CANARY_ADMISSION_TOKEN", "WORKER_ADMISSION_CONFIG_JSON"] as const;
export const CLOUD_KEYRINGS = [
  { name: "CLOUD_WORKSPACE_SECRET_KEYS_JSON", version: "CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION", legacy: "CLOUD_WORKSPACE_SECRET_KEY_V1" },
  { name: "CLOUD_WORKSPACE_OBJECT_KEYS_JSON", version: "CLOUD_WORKSPACE_OBJECT_CURRENT_KEY_VERSION", legacy: "CLOUD_WORKSPACE_OBJECT_KEY_V1" },
  { name: "CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON", version: "CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION", legacy: null },
] as const;
export const CLOUD_ENABLE_FLAGS = ["CLOUD_WORKSPACES_ENABLED", "CLOUD_WORKSPACE_BACKGROUND_WORKERS_ENABLED", "CLOUD_WORKSPACE_SETUP_WORKER_ENABLED"] as const;

const constants = {
  BOAT_TTL_SECONDS: "900", BOAT_SECONDS_PER_DOLLAR: "100000",
  CLOUD_WORKSPACE_CPU_MILLICORES: "4000", CLOUD_WORKSPACE_MEMORY_MIB: "8192",
  CLOUD_WORKSPACE_OBJECT_STORE_KIND: "s3", CLOUD_WORKSPACE_S3_REGION: "auto",
  CLOUD_WORKSPACE_OBJECT_RESTORE_WINDOW_HOURS: "336",
  EMAIL_FROM: "Zeros <notifications@zeros.build>", OPERATIONS_ALERT_EMAIL: "alert@zeros.build",
} as const;
const existingRequired = ["DATABASE_URL", "AUTH_AUDIENCE", "GITHUB_APP_ID", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_SLUG", "GITHUB_OAUTH_CALLBACK_URL", "GITHUB_APP_PRIVATE_KEY"] as const;
const workosRequired = ["AUTH_ISSUER", "AUTH_JWKS_URL", "AUTH_WEB_CLIENT_ID", "AUTH_DESKTOP_CLIENT_ID", "APP_ORIGIN",
  "WORKOS_API_KEY", "WORKOS_COOKIE_PASSWORD", "WORKOS_WEBHOOK_SECRET"] as const;
const identityInputs = ["BOAT_ACCOUNT_SCOPE", "BOAT_BILLING_ORG"] as const;
const diagnostics = { error: () => {}, warn: () => {} };
const present = (value: string | undefined): value is string => typeof value === "string" && value.trim().length > 0;
const validationKeyring = JSON.stringify({ "1": Buffer.alloc(32).toString("base64url") });

const configurationNames = [...CLOUD_WORKER_VARIABLES, ...CLOUD_OWNER_SECRETS, ...CLOUD_CANARY_INPUTS, ...CLOUD_ENABLE_FLAGS,
  ...CLOUD_KEYRINGS.flatMap(keyring => [keyring.name, keyring.version, ...(keyring.legacy ? [keyring.legacy] : [])]),
  ...existingRequired, ...workosRequired, ...identityInputs, ...Object.keys(constants), "BOAT_COMPUTE_POLICY_ID",
  "CLOUD_WORKSPACE_S3_ENDPOINT", "CLOUD_WORKSPACE_S3_BUCKET", "CLOUD_WORKSPACE_CONTROL_PLANE_URL", "ZEROS_DEPLOY_ENV",
  "CLOUD_WORKSPACE_PREVIEW_BASE_DOMAIN", "CLOUD_WORKSPACE_S3_KEY_PREFIX", "CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY",
  "CLOUD_WORKSPACE_PROVIDER_CREDENTIAL_KEY_V1", "CLOUD_WORKSPACE_ENGINE_PORT", "CLOUD_WORKSPACE_SETUP_TIMEOUT_SECONDS",
  "CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION", "CLOUD_WORKSPACE_ENGINE_HEARTBEAT_INTERVAL_MS", "CLOUD_WORKSPACE_OPERATION_TIMEOUT_SECONDS",
  "AUTH_PROVIDER", "AUTH0_DOMAIN", "OPS_ORIGIN", "INVITE_LINK_BASE", "NODE_ENV", "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_NAME",
  "RAILWAY_GIT_BRANCH", "DATABASE_POOL_MAX", "DATABASE_LISTEN_URL", "DATABASE_MIGRATION_URL", "DATABASE_MIGRATION_ROLE"];

export type CloudProvisionStatus = "unchanged" | "set" | "generate" | "missing-input" | "kept-existing";
export type CloudProvisionRow = { name: string; status: CloudProvisionStatus };
export type CloudProvisionValidation = { ok: boolean; names: string[] };
export type CloudProvisionPlan = {
  rows: CloudProvisionRow[]; desired: Record<string, string>; changes: Record<string, string>; generate: string[];
  missingInputs: string[]; workerMissing: string[]; validation: CloudProvisionValidation; enableGate: CloudProvisionValidation;
  workerQualification: "required" | "advisory";
};

/** The six Railway variables that select one Boat worker image. */
export function workerTupleVariables(worker: z.infer<typeof WorkerIdentity>): Record<(typeof CLOUD_WORKER_VARIABLES)[number], string> {
  const match = /^boat:([a-z0-9][a-z0-9-]{0,62})@sha256:([a-f0-9]{64})$/.exec(worker.imageRef);
  if (worker.provider !== "boat" || !match) throw new Error("Only a Boat worker image can be selected");
  return { CLOUD_WORKSPACE_PROVIDER: "boat", BOAT_SNAPSHOT_ID: match[1], BOAT_IMAGE_BUILD_SHA256: match[2],
    ZEROS_CLOUD_SOURCE_COMMIT: worker.sourceSha, ZEROS_CLOUD_IMAGE_ARCHITECTURE: worker.architecture,
    CLOUD_WORKSPACE_STORAGE_MIB: String(worker.storageMiB) };
}

function failureNames(error: unknown): string[] {
  const message = error instanceof Error ? error.message : "";
  const names = configurationNames.filter(name => new RegExp(`\\b${name}\\b`).test(message));
  if (/secret key version|current cloud workspace secret key/.test(message)) names.push(CLOUD_KEYRINGS[0].name, CLOUD_KEYRINGS[0].version);
  if (/object key version/.test(message)) names.push(CLOUD_KEYRINGS[1].name, CLOUD_KEYRINGS[1].version);
  if (/Codex refresh fingerprint/.test(message)) names.push(CLOUD_KEYRINGS[2].name, CLOUD_KEYRINGS[2].version);
  if (/CPU\/memory profile/.test(message)) names.push("ZEROS_CLOUD_IMAGE_ARCHITECTURE", "CLOUD_WORKSPACE_CPU_MILLICORES", "CLOUD_WORKSPACE_MEMORY_MIB");
  if (/all CLOUD_WORKSPACE_S3/.test(message)) names.push("CLOUD_WORKSPACE_S3_ENDPOINT", "CLOUD_WORKSPACE_S3_BUCKET", ...CLOUD_OWNER_SECRETS.slice(1, 3));
  return [...new Set(names.length ? names : ["CONFIGURATION"])].sort();
}

function validateCanaries(values: Record<string, string>): string[] {
  const names: string[] = [];
  const enabled = values.ZEROS_RELEASE_CANARIES_ENABLED;
  if (present(enabled) && enabled !== "true" && enabled !== "false") names.push("ZEROS_RELEASE_CANARIES_ENABLED");
  if (enabled === "true") {
    for (const name of ["RUNTIME_QUALIFICATION_ACTOR_USER_ID", "WORKER_CANARY_ORGANIZATION_ID"]) {
      if (!z.string().uuid().safeParse(values[name]).success) names.push(name);
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(values.WORKER_CANARY_REPOSITORY ?? "")) names.push("WORKER_CANARY_REPOSITORY");
    if ((values.WORKER_CANARY_ADMISSION_TOKEN?.length ?? 0) < 32) names.push("WORKER_CANARY_ADMISSION_TOKEN");
  }
  if (enabled === "true" || Object.hasOwn(values, "WORKER_ADMISSION_CONFIG_JSON")) {
    let parsed;
    try { parsed = BoatAccountAdmissionConfigurationSchema.safeParse(JSON.parse(values.WORKER_ADMISSION_CONFIG_JSON ?? "")); } catch { parsed = null; }
    if (!parsed?.success || parsed.data.profile.boat.accountScope !== values.BOAT_ACCOUNT_SCOPE ||
      parsed.data.profile.boat.billingOrg !== values.BOAT_BILLING_ORG) names.push("WORKER_ADMISSION_CONFIG_JSON");
  }
  return names;
}

export function validateCloudProvisionConfiguration(values: Record<string, string>, channel: Channel,
  inputs: NodeJS.ProcessEnv = {}): CloudProvisionValidation {
  const names = validateCanaries(values);
  const databaseUrl = "postgresql://cloud_provision@127.0.0.1:5432/zeros";
  const env: NodeJS.ProcessEnv = { ...values, DATABASE_URL: databaseUrl,
    ...(values.DATABASE_LISTEN_URL ? { DATABASE_LISTEN_URL: databaseUrl } : {}),
    ...(values.DATABASE_MIGRATION_URL ? { DATABASE_MIGRATION_URL: databaseUrl } : {}),
    RAILWAY_PROJECT_ID: inputs.RAILWAY_PROJECT_ID ?? values.RAILWAY_PROJECT_ID,
    RAILWAY_ENVIRONMENT_NAME: channel, RAILWAY_GIT_BRANCH: inputs.RELEASE_BRANCH ?? values.RAILWAY_GIT_BRANCH };
  try { loadConfig(env, diagnostics); } catch (error) { names.push(...failureNames(error)); }
  return { ok: names.length === 0, names: [...new Set(names)].sort() };
}

function singleVersionOne(encoded: string): boolean {
  try {
    const keys: unknown = JSON.parse(encoded);
    return keys !== null && typeof keys === "object" && !Array.isArray(keys) && Object.keys(keys).length === 1 && Object.hasOwn(keys, "1");
  } catch { return false; }
}

export function planCloudProvision(options: { channel: Channel; current: Readonly<Record<string, string>>;
  inputs: NodeJS.ProcessEnv; enableCloud?: boolean; qualification?: unknown; generatedKeyrings?: Readonly<Record<string, string>>;
  /** Fills an entirely absent tuple; never replaces a selected one. */
  adoptWorker?: z.infer<typeof WorkerIdentity>;
  /** False while worker promotion is off: enabling cloud needs a selected tuple, not native qualification. */
  qualificationRequired?: boolean }): CloudProvisionPlan {
  const { channel, current, inputs } = options;
  const qualificationRequired = options.qualificationRequired ?? true;
  const rows = new Map<string, CloudProvisionRow>(), desired: Record<string, string> = {}, changes: Record<string, string> = {};
  const missingInputs: string[] = [], generate: string[] = [];
  const row = (name: string, status: CloudProvisionStatus) => rows.set(name, { name, status });
  const keep = (name: string) => { desired[name] = current[name]; row(name, "kept-existing"); };
  const set = (name: string, value: string, status?: CloudProvisionStatus) => {
    desired[name] = value;
    if (value !== current[name]) changes[name] = value;
    row(name, status ?? (value === current[name] ? "unchanged" : "set"));
  };
  const missing = (name: string, required: boolean) => {
    if (Object.hasOwn(current, name)) desired[name] = current[name];
    row(name, "missing-input");
    if (required) missingInputs.push(name);
  };
  for (const [name, value] of Object.entries(constants)) {
    if (["BOAT_TTL_SECONDS", "BOAT_SECONDS_PER_DOLLAR"].includes(name) && Object.hasOwn(current, "BOAT_COMPUTE_POLICY_ID") &&
      Object.hasOwn(current, name)) keep(name);
    else set(name, value);
  }
  set("CLOUD_WORKSPACE_S3_BUCKET", `zeros-cloud-workspaces-${channel}`);
  set("CLOUD_WORKSPACE_CONTROL_PLANE_URL", CHANNELS[channel].api);
  set("ZEROS_DEPLOY_ENV", channel);
  if (Object.hasOwn(current, "BOAT_COMPUTE_POLICY_ID")) keep("BOAT_COMPUTE_POLICY_ID");
  else set("BOAT_COMPUTE_POLICY_ID", `zeros-${channel}-standard-v1`);
  for (const name of [...CLOUD_OWNER_SECRETS, ...CLOUD_CANARY_INPUTS]) {
    if (present(inputs[name])) set(name, inputs[name]);
    else if (present(current[name])) keep(name);
    else missing(name, (CLOUD_OWNER_SECRETS as readonly string[]).includes(name));
  }
  for (const name of identityInputs) {
    if (present(inputs[name])) set(name, inputs[name]);
    else missing(name, true);
  }
  const endpoint = inputs.CLOUD_WORKSPACE_S3_ENDPOINT;
  const account = inputs.CLOUD_ACCOUNT_ID || inputs.CLOUDFLARE_ACCOUNT_ID;
  if (present(endpoint)) set("CLOUD_WORKSPACE_S3_ENDPOINT", endpoint);
  else if (present(account)) {
    if (!/^[a-f0-9]{32}$/.test(account)) missing(inputs.CLOUD_ACCOUNT_ID ? "CLOUD_ACCOUNT_ID" : "CLOUDFLARE_ACCOUNT_ID", true);
    else set("CLOUD_WORKSPACE_S3_ENDPOINT", `https://${account}.r2.cloudflarestorage.com`);
  } else if (present(current.CLOUD_WORKSPACE_S3_ENDPOINT)) keep("CLOUD_WORKSPACE_S3_ENDPOINT");
  else missing("CLOUD_WORKSPACE_S3_ENDPOINT", true);
  for (const keyring of CLOUD_KEYRINGS) {
    if (keyring.legacy && Object.hasOwn(current, keyring.legacy)) keep(keyring.legacy);
    if (Object.hasOwn(current, keyring.name)) {
      keep(keyring.name);
      if (Object.hasOwn(current, keyring.version)) keep(keyring.version);
      else if (singleVersionOne(current[keyring.name])) set(keyring.version, "1");
      else missing(keyring.version, true);
    } else if (keyring.legacy && Object.hasOwn(current, keyring.legacy)) {
      set(keyring.name, JSON.stringify({ "1": current[keyring.legacy].trim() }));
      if (Object.hasOwn(current, keyring.version)) keep(keyring.version);
      else set(keyring.version, "1");
    } else if (Object.hasOwn(current, keyring.version)) {
      keep(keyring.version); missing(keyring.name, true);
    } else {
      generate.push(keyring.name); row(keyring.name, "generate"); set(keyring.version, "1");
      if (options.generatedKeyrings?.[keyring.name] !== undefined) set(keyring.name, options.generatedKeyrings[keyring.name], "generate");
    }
  }
  const adopted = options.adoptWorker && CLOUD_WORKER_VARIABLES.every(name => !Object.hasOwn(current, name))
    ? workerTupleVariables(options.adoptWorker) : null;
  const workerMissing = adopted ? [] : CLOUD_WORKER_VARIABLES.filter(name => !present(current[name]));
  for (const name of CLOUD_WORKER_VARIABLES) {
    if (adopted) set(name, adopted[name]);
    else if (Object.hasOwn(current, name)) keep(name);
    else missing(name, false);
  }
  for (const name of [...existingRequired, ...(current.AUTH_PROVIDER === "workos" ? workosRequired : [])]) {
    if (present(current[name])) keep(name);
    else missing(name, true);
  }
  if (present(current.CLOUD_WORKSPACE_PREVIEW_BASE_DOMAIN)) missing("CLOUD_WORKSPACE_PREVIEW_BASE_DOMAIN", true);
  else row("CLOUD_WORKSPACE_PREVIEW_BASE_DOMAIN", "unchanged");
  const plannedKeyrings = Object.fromEntries(generate.map(name => [name, options.generatedKeyrings?.[name] ?? validationKeyring]));
  const placeholders = { CLOUD_WORKSPACE_PROVIDER: "boat", BOAT_SNAPSHOT_ID: `zeros-${channel}-validation`,
    BOAT_IMAGE_BUILD_SHA256: "0".repeat(64), ZEROS_CLOUD_SOURCE_COMMIT: "0".repeat(40),
    ZEROS_CLOUD_IMAGE_ARCHITECTURE: "linux/amd64", CLOUD_WORKSPACE_STORAGE_MIB: "20480" };
  const candidate = { ...Object.fromEntries(workerMissing.map(name => [name, placeholders[name]])), ...current, ...desired, ...plannedKeyrings,
    ...Object.fromEntries(CLOUD_ENABLE_FLAGS.map(name => [name, "true"])) };
  const validation = validateCloudProvisionConfiguration(candidate, channel, inputs);
  if (candidate.CLOUD_WORKSPACE_PROVIDER !== "boat") {
    validation.ok = false; validation.names = [...new Set([...validation.names, "CLOUD_WORKSPACE_PROVIDER"])].sort();
  }
  const selected = { ...current, ...(adopted ?? {}) };
  const selectedWorker = WorkerIdentity.safeParse({ provider: selected.CLOUD_WORKSPACE_PROVIDER,
    imageRef: `boat:${selected.BOAT_SNAPSHOT_ID}@sha256:${selected.BOAT_IMAGE_BUILD_SHA256}`, sourceSha: selected.ZEROS_CLOUD_SOURCE_COMMIT,
    architecture: selected.ZEROS_CLOUD_IMAGE_ARCHITECTURE, storageMiB: Number(selected.CLOUD_WORKSPACE_STORAGE_MIB) });
  const qualification = ReleaseIdentity.safeParse(options.qualification);
  const qualified = !qualificationRequired || selectedWorker.success && qualification.success && qualification.data.channel === channel &&
    selectedWorker.data.sourceSha === inputs.RELEASE_SHA &&
    qualification.data.sourceSha === inputs.RELEASE_SHA && qualification.data.migrations.head === qualification.data.migrations.expectedHead &&
    qualification.data.workerQualified === true && JSON.stringify(qualification.data.worker) === JSON.stringify(selectedWorker.data);
  const gateNames = [...new Set([...missingInputs, ...workerMissing, ...validation.names, ...(qualified ? [] : ["WORKER_QUALIFICATION"])])].sort();
  const enableGate = { ok: gateNames.length === 0, names: gateNames };
  for (const name of CLOUD_ENABLE_FLAGS) {
    if (options.enableCloud && enableGate.ok) set(name, "true");
    else if (Object.hasOwn(current, name)) keep(name);
    else set(name, "false");
  }
  const boot = validateCloudProvisionConfiguration({ ...current, ...desired, ...plannedKeyrings }, channel, inputs);
  validation.names = [...new Set([...validation.names, ...boot.names])].sort(); validation.ok = validation.names.length === 0;
  return { rows: [...rows.values()].sort((left, right) => left.name.localeCompare(right.name)), desired, changes, generate,
    missingInputs: [...new Set(missingInputs)].sort(), workerMissing, validation, enableGate,
    workerQualification: qualificationRequired ? "required" : "advisory" };
}

export function cloudProvisionSummary(plan: CloudProvisionPlan): string[] {
  return [...plan.rows.map(({ name, status }) => `${name} ${status}`), `CONFIGURATION ${plan.validation.ok ? "pass" : "fail"}`,
    ...plan.validation.names.map(name => `${name} fail`), `ENABLE_GATE ${plan.enableGate.ok ? "pass" : "fail"}`,
    ...plan.enableGate.names.map(name => `${name} missing-input`),
    ...(plan.workerQualification === "advisory" ? ["WORKER_QUALIFICATION advisory"] : [])];
}
