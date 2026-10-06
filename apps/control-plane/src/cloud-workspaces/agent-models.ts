// The control plane deploys independently of desktop/protocol packages.
// Mirror the curated provider identities; agent-models.test.ts enforces parity
// with catalogs/models-v1.json. Runtime/credential qualification is still required.
const models: Readonly<Record<string, readonly string[]>> = {
  claude: ["claude-fable-5-1[1m]", "claude-fable-5[1m]", "claude-opus-5-5[1m]", "claude-opus-5[1m]", "claude-opus-4-8[1m]", "claude-sonnet-5-5[1m]", "claude-sonnet-5[1m]", "claude-haiku-4-5"],
  codex: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
  cursor: ["default", "grok-4.7", "grok-4.6", "composer-2.5", "grok-4.5"],
};
export function cloudAgentModels(providerOrKind: string): readonly string[] {
  return models[providerOrKind.split("-")[0]!] ?? [];
}
export function cloudAgentModelAllowed(kind: string, model: string, explicit: readonly string[], allModels: boolean): boolean {
  return (allModels ? cloudAgentModels(kind) : explicit).includes(model);
}
