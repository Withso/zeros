// Routine keyed reads are observable through their failures and slow-operation
// diagnostics. Logging every successful request at info level makes ordinary
// settings navigation drown out the lifecycle/prompt events this trace exists
// to diagnose.
const QUIET_AGENT_DISPATCH_TYPES = new Set<string>([
  "AGENT_LIST_AGENTS",
  "AGENT_LIST_SESSIONS",
  "AGENT_MEMORY_SETTINGS_READ",
  "AGENT_CONFIGURATION_PROVENANCE_READ",
  "AGENT_PROVIDER_QUOTA_READ",
]);

export function shouldLogAgentDispatch(type: string): boolean {
  return !QUIET_AGENT_DISPATCH_TYPES.has(type);
}
