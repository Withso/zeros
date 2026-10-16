// "Create and ask agent to sync styles": the workspace header records the
// request while the Design directory is being created, and the Design surface
// takes it once the new directory's snapshot has loaded, opening the agent
// chat there. Bounded, in memory only; a reload simply forgets the request.

const MAX_REQUESTS = 16;
const requests = new Set<string>();

export function requestDesignSyncAgent(workspaceId: string): void {
  requests.delete(workspaceId);
  requests.add(workspaceId);
  while (requests.size > MAX_REQUESTS) {
    requests.delete(requests.values().next().value as string);
  }
}

/** True once per request: the caller opens the agent chat. */
export function takeDesignSyncAgentRequest(workspaceId: string): boolean {
  return requests.delete(workspaceId);
}

export function resetDesignSyncAgentRequestsForTests(): void {
  requests.clear();
}
