// ──────────────────────────────────────────────────────────
// AI settings persistence — provider/model/key plumbing
// ──────────────────────────────────────────────────────────
//
// The live agent lifecycle runs through the engine AgentGateway; the
// renderer only persists the non-secret AI settings here and hydrates
// the API key from the keychain on mount.
//
// ──────────────────────────────────────────────────────────

// The full provider + settings types now live in store.tsx (they grew
// to cover auth method, thinking effort and agent teams). Re-exported
// here so the rest of this module reads as before.
export type {
  AiProvider,
  AiSettings,
  AiAuthMethod,
  AiThinkingEffort,
} from "../store/store";
import type { AiSettings } from "../store/store";

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const STORAGE_KEY = "Zeros-ai-settings";

export const DEFAULT_AI_SETTINGS: AiSettings = {
  // Default: Claude via subprocess (the user's own `claude login`).
  // If the CLI isn't installed the settings UI surfaces the fallback.
  provider: "claude",
  authMethod: "subscription",
  proxyUrl: "http://127.0.0.1:10531",
  apiKey: "",
  model: "gpt-4o",
  temperature: 0.7,
  autoSendFeedback: false,
  thinkingEffort: "high",
  permissionMode: "plan",
  agentTeams: false,
};

// ── Settings persistence ─────────────────────────────────
//
// Split by sensitivity: non-secret fields (provider, model, temperature,
// proxyUrl, autoSendFeedback) live in localStorage for synchronous
// access during initial render. The apiKey lives in the macOS
// keychain via src/native/secrets.ts and is hydrated asynchronously
// after mount via hydrateAiApiKey().

export function loadAiSettings(): AiSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Strip any legacy apiKey that might be sitting in localStorage
      // from pre-Phase-2-C builds — it's about to be migrated to the
      // keychain on the next save and we don't want it leaking back.
      const { apiKey: _legacy, ...rest } = parsed as Partial<AiSettings>;
      return { ...DEFAULT_AI_SETTINGS, ...rest };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_AI_SETTINGS };
}

/**
 * Read the api key from the keychain and merge it into an existing
 * AiSettings snapshot. If the legacy value is still sitting in
 * localStorage from an old build, migrate it to keychain before
 * returning — one-time cleanup so no secret stays in plaintext.
 */
/** Map the active provider to the keychain slot holding its key. */
async function keySlotFor(provider: AiSettings["provider"]) {
  const { SECRET_ACCOUNTS } = await import("../../native/secrets");
  return provider === "claude"
    ? SECRET_ACCOUNTS.ANTHROPIC_API_KEY
    : SECRET_ACCOUNTS.OPENAI_API_KEY;
}

export async function hydrateAiApiKey(settings: AiSettings): Promise<AiSettings> {
  const { getSecret, setSecret, SECRET_ACCOUNTS } = await import(
    "../../native/secrets"
  );
  const slot = await keySlotFor(settings.provider);
  let apiKey = (await getSecret(slot)) ?? "";

  // One-shot migration from the old localStorage blob. The legacy
  // path only ever stored an OpenAI key, so move it into that slot
  // regardless of the current provider.
  if (!apiKey) {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed.apiKey === "string" && parsed.apiKey) {
          await setSecret(SECRET_ACCOUNTS.OPENAI_API_KEY, parsed.apiKey);
          const { apiKey: _, ...rest } = parsed as Partial<AiSettings>;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
          // Re-read the slot for the current provider — the migrated
          // key only matches when provider is codex / openai.
          apiKey = (await getSecret(slot)) ?? "";
        }
      }
    } catch {
      /* nothing to migrate */
    }
  }

  return { ...settings, apiKey };
}

