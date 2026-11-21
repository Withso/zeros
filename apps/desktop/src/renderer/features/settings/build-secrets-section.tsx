import { useState } from "react";
import { Button, Input } from "../../shared/ui";
import { IconButton } from "../../shared/ui/primitives/icon-button";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { X } from "lucide-react";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { getCloudBuildSecretNames, updateCloudBuildSecrets } from "../../platform/cloud-github-levels";
import { message } from "./cloud-computer-store";
import { SettingsGroup, SettingsRow } from "./settings-ui";

export const BUILD_SECRETS_HINT = "Only this project's ready copy build reads them, from its setup's environment; workspaces never get them. "
  + "Don't write a value to a file: a copy whose disk still holds one is not used. Values shorter than 4 characters are not searched for.";
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const names = new KeyedAsyncCache<string[]>({ maxEntries: 32 });

/** Ready copies, whoever edits the project: write-only values, listed by name. */
export function BuildSecretsSection({ ownerKey, organizationId, projectId, active, disabled }: {
  ownerKey: string; organizationId: string; projectId: string; active: boolean; disabled: boolean;
}) {
  const key = JSON.stringify([ownerKey, projectId]);
  const read = useRecoveringRead(names, key, () => getCloudBuildSecretNames(organizationId, projectId), { enabled: active, maxAgeMs: 30_000 });
  const [name, setName] = useState(""), [value, setValue] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const change = async (update: { set?: Record<string, string>; remove?: string[] }) => {
    setBusy(true); setError(null);
    try {
      names.setData(key, await updateCloudBuildSecrets(organizationId, projectId, update));
      if (update.set) { setName(""); setValue(""); }
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const valid = NAME.test(name) && value.length > 0;
  return (
    <SettingsGroup title="Build secrets" description={BUILD_SECRETS_HINT}>
      {error && <MessageRow tone="error" role="alert" flush>{error}</MessageRow>}
      {(read.data ?? []).map(secret => (
        <SettingsRow key={secret} label={secret} hint="Set">
          <IconButton size="compact" label={`Remove ${secret}`} disabled={disabled || busy} onClick={() => void change({ remove: [secret] })}>
            <X aria-hidden />
          </IconButton>
        </SettingsRow>
      ))}
      <div className="flex items-center gap-2">
        <Input aria-label="Build secret name" placeholder="NAME" value={name} onChange={event => setName(event.target.value)} disabled={disabled || busy} />
        <Input aria-label="Build secret value" placeholder="Value" type="password" autoComplete="off" value={value}
          onChange={event => setValue(event.target.value)} disabled={disabled || busy} />
        <Button variant="secondary" disabled={disabled || busy || !valid} onClick={() => void change({ set: { [name]: value } })}>Save</Button>
      </div>
    </SettingsGroup>
  );
}
