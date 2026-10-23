// Read-side shapes consumed by the mapper, checked against @openai/codex 0.162.1.
// Source: Local generated Codex schema and mapper at 4baf69ec. These deliberately
// describe consumed fields only; runtime snapshots may include additional data.
export type MessagePhase = "commentary" | "final_answer";
export type AsyncUserInputQuestion = { title: string; options: string[] | null };
export type McpServerOauthLoginCompletedNotification = { name: string; loginId?: string; success: boolean };
export type WebSearchAction =
  | { type: "search"; query?: string; queries?: string[] }
  | { type: "open_page"; url?: string }
  | { type: "find_in_page"; url?: string; pattern?: string }
  | { type: "other" };
export type ImageGenerationItem = {
  id: string; status: string; revisedPrompt: string | null; result: string;
  transparentBackground?: boolean; failure: unknown; savedPath?: string;
};
// The mapper already declares compatibility shapes for all ordinary items.
// This union adds the remaining pinned variants without importing generated
// engine files into the worker's build.
export type ThreadItem =
  | { type: "sleep"; id: string; durationMs: number }
  | { type: "subAgentActivity"; id: string; kind: string; agentThreadId: string; agentPath: string; model: string | null; reasoningEffort: string | null }
  | { type: "hookPrompt"; id: string; [key: string]: unknown }
  | { type: "functionCallOutput"; id: string; [key: string]: unknown };
