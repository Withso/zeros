import { agentFamily, getFavoriteModel, resolveModelOption } from "./model-catalog";

// Persisted null chat models and old family effort/Fast fields predate the
// current birth policy. Freeze their prior meaning; new chats use the catalog.
const LEGACY_DEFAULT_MODELS: Record<string, string> = {
  claude: "claude-opus-5[1m]",
  codex: "gpt-5.6-sol",
  cursor: "composer-2.5",
};

export function legacySelectedModel(agentId: string | null): string | null {
  const family = agentFamily(agentId);
  const selected = getFavoriteModel(agentId);
  if (selected && resolveModelOption(agentId, selected, null)) return selected;
  return LEGACY_DEFAULT_MODELS[family] ?? null;
}
