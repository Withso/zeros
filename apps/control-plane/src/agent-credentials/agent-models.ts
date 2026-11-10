// The control plane deploys independently of desktop/protocol packages.
// Mirror the curated provider identities; agent-models.test.ts enforces parity
// with catalogs/models-v1.json. Runtime/credential qualification is still required.
type CloudAgentCatalogEntry = { agent: string; models: readonly { id: string; effortLevels?: readonly string[] }[] };
const catalog: readonly CloudAgentCatalogEntry[] = [
  { agent: "claude", models: [
    { id: "claude-fable-5-1[1m]", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
    { id: "claude-fable-5[1m]", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
    { id: "claude-opus-5-5[1m]", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
    { id: "claude-opus-5[1m]", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
    { id: "claude-opus-4-8[1m]", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
    { id: "claude-sonnet-5-5[1m]", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-sonnet-5[1m]", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
    { id: "claude-haiku-5-5", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-haiku-4-5" }
  ] },
  { agent: "codex", models: [
    { id: "gpt-6-astra", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
    { id: "gpt-6.1-sol", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
    { id: "gpt-6.1-terra", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
    { id: "gpt-6-sol", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
    { id: "gpt-6-luna", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.6-sol", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
    { id: "gpt-5.6-terra", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
    { id: "gpt-5.6-luna", effortLevels: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.5", effortLevels: ["low", "medium", "high", "xhigh"] }
  ] },
  { agent: "cursor", models: [
    { id: "default" },
    { id: "grok-4.7", effortLevels: ["low", "medium", "high", "xhigh"] },
    { id: "grok-4.6", effortLevels: ["low", "medium", "high", "xhigh"] },
    { id: "composer-2.5" },
    { id: "grok-4.5", effortLevels: ["low", "medium", "high"] }
  ] }
];
const models: Readonly<Record<string, readonly string[]>> = Object.fromEntries(catalog.map(entry => [entry.agent, entry.models.map(model => model.id)]));
export function cloudAgentCatalog(): readonly CloudAgentCatalogEntry[] { return catalog; }
export function cloudAgentModels(providerOrKind: string): readonly string[] {
  return models[providerOrKind.split("-")[0]!] ?? [];
}
export function cloudAgentModelAllowed(kind: string, model: string, explicit: readonly string[], allModels: boolean): boolean {
  return (allModels ? cloudAgentModels(kind) : explicit).includes(model);
}
