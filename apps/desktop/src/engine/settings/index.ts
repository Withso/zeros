// Public surface of the engine settings module: schemas, file layers,
// resolution, bridge operations, and file watching.
export {
  managedSettingsSchema,
  PROVIDER_AUTH_METHODS,
  repoSettingsSchema,
  RUN_MODES,
  sanitizeLayer,
  SCHEMA_URL_REPO,
  SCHEMA_URL_USER,
  USER_ONLY_KEYS,
  userSettingsSchema,
} from "./schema";
export type {
  RawSettingsDoc,
  RepoSettingsDoc,
  SanitizeResult,
  SettingsLayerName,
  UserSettingsDoc,
} from "./schema";
export { DEFAULT_SETTINGS, resolveSettings } from "./resolve";
export type { ResolvedSettings, SettingsLayers } from "./resolve";
export {
  applySettingsPatch,
  managedSettingsPath,
  readSettingsFile,
  REPO_SETTINGS_DIRNAME,
  repoLocalSettingsPath,
  repoSettingsPath,
  schemaUrlForLayer,
  updateSettingsFile,
  userSettingsDir,
  userSettingsPath,
  writeSettingsFile,
} from "./files";
export type { ReadSettingsResult, WriteSettingsOptions } from "./files";
export {
  ensureLocalSettingsIgnored,
  opSettingsMigrateLegacy,
  opSettingsRead,
  opSettingsResolve,
  opSettingsWrite,
  READABLE_LAYERS,
  REDACTED_SENTINEL,
  redactDocForRemote,
  redactResolvedForRemote,
  SettingsOpError,
  WRITABLE_LAYERS,
} from "./ops";
export type {
  MigrateLegacyInput,
  MigrateLegacyResult,
  ReadableLayer,
  SettingsReadOpResult,
  SettingsWriteOpResult,
  WritableLayer,
} from "./ops";
export { startSettingsWatcher } from "./watch";
export type { SettingsWatcher } from "./watch";
export { mergeSpawnEnv, parseDotenv, resolveSpawnEnv } from "./spawn-env";
export type { SpawnEnvResult } from "./spawn-env";
export { resolveRepoScript } from "./repo-scripts";
export type { RepoScriptKind } from "./repo-scripts";
export { applyUserProviderConfig } from "./provider-env";
export type { ProviderSpawn } from "./provider-env";
