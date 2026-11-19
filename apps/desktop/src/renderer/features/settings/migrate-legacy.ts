
import { getSetting, setSetting } from "../../platform/settings";
import { getSecret } from "../../platform/secrets";
import { isNativeRuntime } from "../../platform/runtime";
import { isTransportShaped } from "../../platform/bridge/failure";
import { loadProjects } from "../../state/projects-store";
import { getRepoSettings } from "../repositories/repo-settings";
import { getProviderPrefs } from "./provider-prefs";
import {
  legacyEnvSecretNames,
  planLegacyEnvSecretMigration,
  readEnvVaultForEdit,
  writeEnvVault,
} from "../agent/env-vault";
import {
  bridgeSettingsMigrateLegacy,
  bridgeSettingsRead,
  bridgeSettingsWrite,
} from "../../platform/bridge/workspace-bridge";
import { isRemovedAgent } from "../agent/agent-runnable";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import { toast } from "../../shared/ui/primitives/elements";

const MIGRATED_FLAG = "settings:toml-migrated";

/** Agent ids that historically carried provider prefs (provider-prefs.ts). */
const LEGACY_PROVIDER_AGENT_IDS = ["claude", "codex", "cursor"];

// The Local engine merges into TOML without overriding saved values; migration does not clear the input keys.
export async function ensureSettingsTomlMigrated(
  bridge: RuntimeClient | null,
): Promise<void> {
  if (!bridge) return;
  if (getSetting<boolean>(MIGRATED_FLAG, false)) return;

  const repos = loadProjects()
    .filter((p) => p.repoRoot)
    .map((p) => ({
      repoRoot: p.repoRoot,
      settings: getRepoSettings(p.id) as unknown as Record<string, unknown>,
    }))
    .filter((r) => {
      const s = r.settings as {
        workspacesPath?: string;
        remoteOrigin?: string;
        baseBranch?: string;
        scripts?: unknown[];
      };
      return Boolean(
        s.workspacesPath ||
        s.remoteOrigin ||
        s.baseBranch ||
        (Array.isArray(s.scripts) && s.scripts.length > 0),
      );
    });

  const providers: Record<string, Record<string, unknown>> = {};
  for (const agentId of LEGACY_PROVIDER_AGENT_IDS) {
    const prefs = getProviderPrefs(agentId) as unknown as Record<
      string,
      unknown
    >;
    if (prefs.authMethod || prefs.binaryPath || prefs.gatewayBaseUrl) {
      providers[agentId] = prefs;
    }
  }

  if (repos.length === 0 && Object.keys(providers).length === 0) {
    setSetting(MIGRATED_FLAG, true);
    return;
  }

  try {
    const result = await bridgeSettingsMigrateLegacy(bridge, {
      repos,
      providers,
    });
    setSetting(MIGRATED_FLAG, true);
    if (result.warnings.length > 0) {
      console.warn("[zeros] settings migration notes:", result.warnings);
      // Some legacy scripts have no new slot; tell the user which setup needs attention.
      toast.info(
        `Settings migrated with ${result.warnings.length} note${
          result.warnings.length === 1 ? "" : "s"
        } — some legacy scripts need re-adding under Repo → Scripts.`,
      );
    }
  } catch (err) {
    // Leave the flag unset — retried on the next boot / settings-page open.
    console.warn("[zeros] settings migration failed (will retry):", err);
  }
}

const ENV_VAULT_MIGRATED_FLAG = "env-vault:legacy-secrets-migrated";

// Import env:: Keychain accounts named by the legacy TOML sentinel. Existing vault entries win; copy before deleting sentinels so retries cannot lose values.
export async function ensureEnvSecretsInVault(
  bridge: RuntimeClient | null,
): Promise<void> {
  if (!bridge) return;
  // Only this desktop can read env:: accounts; relay clients would mistake them for missing values.
  if (!isNativeRuntime()) return;
  if (getSetting<boolean>(ENV_VAULT_MIGRATED_FLAG, false)) return;
  try {
    const read = await bridgeSettingsRead(bridge, "user");
    const rawEnv = (read.doc as { env?: unknown }).env;
    const fileEnv =
      rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)
        ? (rawEnv as Record<string, unknown>)
        : {};
    const names = legacyEnvSecretNames(fileEnv);
    if (names.length === 0) {
      setSetting(ENV_VAULT_MIGRATED_FLAG, true);
      return;
    }
    // Abort on an unreadable vault rather than migrating as if it were empty.
    const vault = await readEnvVaultForEdit({ kind: "user" });
    const legacyValues: Record<string, string | null> = {};
    for (const name of names) {
      legacyValues[name] = await getSecret(`env::${name}`);
    }
    const plan = planLegacyEnvSecretMigration(fileEnv, vault, legacyValues);
    if (Object.keys(plan.copy).length > 0) {
      await writeEnvVault({ kind: "user" }, { ...vault, ...plan.copy });
      console.info(
        "[zeros] migrated legacy env secrets into the Keychain vault:",
        Object.keys(plan.copy),
      );
    }
    if (plan.removeFromFile.length > 0) {
      const patch: Record<string, null> = {};
      for (const name of plan.removeFromFile) patch[name] = null;
      await bridgeSettingsWrite(bridge, "user", { env: patch });
    }
    setSetting(ENV_VAULT_MIGRATED_FLAG, true);
    if (plan.unrecovered.length > 0) {
      toast.info(
        `Couldn't recover ${plan.unrecovered.join(", ")} from the Keychain — re-add ${
          plan.unrecovered.length === 1 ? "it" : "them"
        } in Settings → Environment.`,
      );
    }
  } catch (err) {
    // Leave the flag unset — retried on the next boot.
    console.warn(
      "[zeros] env-secret vault migration failed (will retry):",
      err,
    );
  }
}

// Run ungated at boot so later retirements self-clean; prune only explicit retirements without needing the registry.
export async function pruneRetiredProviders(
  bridge: RuntimeClient | null,
): Promise<void> {
  if (!bridge) return;
  try {
    const read = await bridgeSettingsRead(bridge, "user");
    const providers = (read.doc as { providers?: Record<string, unknown> })
      .providers;
    if (!providers || typeof providers !== "object") return;
    const stale = Object.keys(providers).filter((id) =>
      isRemovedAgent(id, null),
    );
    if (stale.length === 0) return;
    // Null deletes a leaf; the Local engine applies the patch before sanitizing.
    const patch: Record<string, null> = {};
    for (const id of stale) patch[id] = null;
    await bridgeSettingsWrite(bridge, "user", { providers: patch });
    console.info(
      "[zeros] pruned retired provider entries from settings.toml:",
      stale,
    );
  } catch (err) {
    // Engine swaps can abort pruning; the next boot retries without a warning.
    const message = err instanceof Error ? err.message : String(err);
    if (isTransportShaped(message)) return;
    console.warn(
      "[zeros] prune-retired-providers failed (will retry next boot):",
      err,
    );
  }
}
