// Retention's rule, stated once on General (an organization's, and Personal's for its cloud owner), only where
// that organization's server runs retention (the workspace list's `retention: true`). Nothing otherwise.
import { useCloudRetention } from "../../platform/cloud-retention-state";
import { CLOUD_RETENTION_RULE, CLOUD_RETENTION_RULE_LABELS } from "./cloud-retention-copy";
import { SettingsGroup, SettingsRow } from "./settings-ui";

export function CloudRetentionRule({ organizationId }: { organizationId: string | null | undefined }) {
  const on = useCloudRetention(organizationId);
  if (!on) return null;
  return (
    <SettingsGroup title="Cloud workspaces" aria-label="Archiving cloud workspaces">
      {CLOUD_RETENTION_RULE.map((sentence, index) => <SettingsRow key={index} label={CLOUD_RETENTION_RULE_LABELS[index]!} hint={sentence} />)}
    </SettingsGroup>
  );
}
