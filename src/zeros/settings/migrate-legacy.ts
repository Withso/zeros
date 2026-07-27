// ──────────────────────────────────────────────────────────
// Settings foundation — one-time localStorage → TOML migration
// ──────────────────────────────────────────────────────────
//
// Ships the renderer's legacy settings blobs (`repo-settings:<projectId>`,
// `provider-prefs:<agentId>`) to the engine's LOCAL-ONLY `settings.migrateLegacy`
// op, which writes them into the TOML layers with merge-under semantics (an
// existing file value always wins — re-runs can never clobber). The legacy
// blobs are kept (not deleted) as a safety net; they stop being read once the
// panels are on the bridge.
// ──────────────────────────────────────────────────────────

import { getSetting, setSetting } from "../../native/settings";
import { getSecret } from "../../native/secrets";
import { isNativeRuntime } from "../../native/runtime";
import { loadProjects } from "../store/projects-store";
import { getRepoSettings } from "../panels/repo-settings";
import { getProviderPrefs } from "../panels/provider-prefs";
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
} from "../bridge/workspace-bridge";
import { isRemovedAgent } from "../agent/agent-runnable";
import type { RuntimeClient } from "../bridge/ws-client";
import { toast } from "../ui/primitives/elements";

const MIGRATED_FLAG = "settings:toml-migrated";

/** Agent ids that historically carried provider prefs (provider-prefs.ts). */
const LEGACY_PROVIDER_AGENT_IDS = ["claude", "codex", "cursor"];

/** Run the one-time migration if it hasn't run on this device. */
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
    // Only ship blobs that actually carry something.
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
      // Surface lossy mappings (e.g. extra scripts that had no setup/run/archive
      // home) so it isn't silent data loss — a console line nobody reads.
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

/** One-time import of legacy 🔒 env secrets into the Keychain env vault.
 *
 *  The pre-vault Environment UI stored a locked value under the Keychain
 *  account `env::<NAME>` and wrote the `"${zeros.secret}"` sentinel into the
 *  user settings.toml `[env]` table; the courier that delivered those values
 *  at spawn was deleted with the vault redesign (2026-07-16), so without this
 *  they'd silently stop reaching agents. For each sentinel entry: copy the
 *  recoverable Keychain value into the user vault (existing vault names win),
 *  then null the dead sentinel row out of the file (spawn-env skips sentinels
 *  either way; the row only misleads). The `env::` accounts are left in place
 *  as a safety net, mirroring the localStorage blobs above.
 *
 *  Ordering makes a partial failure safe: the vault write lands FIRST, so if
 *  the file cleanup fails the vault already shadows the sentinel rows and the
 *  unset flag retries (idempotently — planned names already in the vault are
 *  skipped) on the next boot. */
export async function ensureEnvSecretsInVault(
  bridge: RuntimeClient | null,
): Promise<void> {
  if (!bridge) return;
  // Desktop only: the `env::` accounts live in THIS machine's secret store. A
  // web/relay client reads null for every name and would mis-plan the
  // sentinel rows as unrecoverable — stripping them from the shared user file
  // before the desktop gets to migrate the real values.
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
    // Throws when the vault exists but couldn't be read — abort (flag stays
    // unset, retried next boot) rather than plan against a map we can't see.
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
      // Not silent data loss: the variable stopped flowing with the old
      // courier's removal — say so once, with the fix.
      toast.info(
        `Couldn't recover ${plan.unrecovered.join(", ")} from the Keychain — re-add ${
          plan.unrecovered.length === 1 ? "it" : "them"
        } in Settings → Environment.`,
      );
    }
  } catch (err) {
    // Leave the flag unset — retried on the next boot.
    console.warn("[zeros] env-secret vault migration failed (will retry):", err);
  }
}

/** Prune dead `[providers.<id>]` entries for agents that were REMOVED from the
 *  product — e.g. a leftover `factory-droid` table written into a user's
 *  settings.toml while it was still a supported agent (retired 2026-06-16),
 *  which nothing reads or re-writes once the agent is gone.
 *
 *  Matches the renderer's RETIRED_AGENT_PATTERNS via `isRemovedAgent(id, null)`
 *  — a registry-independent check that's true ONLY for explicitly-retired ids
 *  (current + unknown ids are left alone), so it's safe to run at boot before
 *  the registry has loaded. UNGATED + idempotent: runs every boot but writes
 *  only when a stale entry is actually found, so a FUTURE retirement
 *  self-cleans without another flag. */
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
    // A null leaf deletes the key (applySettingsPatch). opSettingsWrite applies
    // the patch BEFORE sanitizing, so the deletion isn't stripped.
    const patch: Record<string, null> = {};
    for (const id of stale) patch[id] = null;
    await bridgeSettingsWrite(bridge, "user", { providers: patch });
    console.info(
      "[zeros] pruned retired provider entries from settings.toml:",
      stale,
    );
  } catch (err) {
    console.warn(
      "[zeros] prune-retired-providers failed (will retry next boot):",
      err,
    );
  }
}
