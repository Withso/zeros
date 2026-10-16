import { createHash } from "node:crypto";
import path from "node:path";
import { migrateSecretsIfAbsent } from "./secret-store";

/** Only account-free Local's former per-checkout provider slots are adopted.
 * Hosted login, GitHub, owner/device credentials and other app state remain
 * isolated. Profile paths are deliberately retained: native keychains use them. */
export function migrateLocalProviderSecrets(instanceDataDir: string): void {
  const source = path.join(instanceDataDir, "secrets.json");
  const migration = createHash("sha256").update(source).digest("hex");
  migrateSecretsIfAbsent(
    source,
    [
      "anthropic-api-key",
      "openai-api-key",
      "cursor-api-key",
      "cursor-subscription",
      "provider-accounts-claude",
      "provider-accounts-codex",
      "provider-accounts-cursor",
      "provider-accounts-claude:revisions",
      "provider-accounts-codex:revisions",
      "provider-accounts-cursor:revisions",
    ],
    `local-provider-migration:${migration}`,
  );
}
