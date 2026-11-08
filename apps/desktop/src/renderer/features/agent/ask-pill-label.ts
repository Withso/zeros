import { agentFamily } from "./model-catalog";

const FAMILY_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" };

/** The agent an unfocused split pane's Ask pill names: "Ask Claude", "Ask
 *  Codex", "Ask Cursor", otherwise the chat's own agent name. */
export function askPillAgentName(agentId: string | null | undefined, agentName: string | null | undefined): string {
  return FAMILY_NAMES[agentFamily(agentId ?? null)] ?? (agentName?.trim() || "agent");
}
