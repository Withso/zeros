// ──────────────────────────────────────────────────────────
// ModelsSettingsSync — keep the model-defaults cache ⇄ settings.toml
// ──────────────────────────────────────────────────────────
//
// settings.toml `[models]` is the durable source of truth; the localStorage
// model-defaults cache ([[new-chat-defaults]]) is the synchronous spawn-read
// copy. This mounts once near the app root and, on each settings resolve:
//   - file has a [models] table  → hydrate the cache from it (so a direct file
//     edit, a synced device, or a fresh checkout is honored);
//   - file has none, cache does  → mirror the cache into the file once (the
//     one-time migration so an existing user's localStorage choices show up in
//     settings.toml without them having to re-pick).
// Re-runs whenever settings change (DB_CHANGED) via useResolvedSettings.
// Renders nothing.
// ──────────────────────────────────────────────────────────

import { useEffect } from "react";

import { useResolvedSettings } from "../settings/use-settings";
import {
  hasModelDefaults,
  hydrateModelsFromSettings,
  mirrorModelsToSettings,
} from "./new-chat-defaults";

export function ModelsSettingsSync(): null {
  const { resolved } = useResolvedSettings();
  useEffect(() => {
    if (!resolved) return;
    const models = (resolved.effective as Record<string, unknown>).models;
    const hasTable =
      !!models && typeof models === "object" && Object.keys(models).length > 0;
    if (hasTable) {
      hydrateModelsFromSettings(models);
    } else if (hasModelDefaults()) {
      mirrorModelsToSettings();
    }
  }, [resolved]);
  return null;
}
