import type { ThreadArchiveParams } from "./generated/v2/ThreadArchiveParams";
import type { ThreadArchiveResponse } from "./generated/v2/ThreadArchiveResponse";
import type { ThreadBackgroundTerminalsCleanParams } from "./generated/v2/ThreadBackgroundTerminalsCleanParams";
import type { ThreadBackgroundTerminalsCleanResponse } from "./generated/v2/ThreadBackgroundTerminalsCleanResponse";
import type { ThreadBackgroundTerminalsListParams } from "./generated/v2/ThreadBackgroundTerminalsListParams";
import type { ThreadBackgroundTerminalsListResponse } from "./generated/v2/ThreadBackgroundTerminalsListResponse";
import type { ThreadBackgroundTerminalsTerminateParams } from "./generated/v2/ThreadBackgroundTerminalsTerminateParams";
import type { ThreadBackgroundTerminalsTerminateResponse } from "./generated/v2/ThreadBackgroundTerminalsTerminateResponse";
import type { ThreadDeleteParams } from "./generated/v2/ThreadDeleteParams";
import type { ThreadDeleteResponse } from "./generated/v2/ThreadDeleteResponse";
import type { ThreadForkParams } from "./generated/v2/ThreadForkParams";
import type { ThreadForkResponse } from "./generated/v2/ThreadForkResponse";
import type { ThreadGoalClearParams } from "./generated/v2/ThreadGoalClearParams";
import type { ThreadGoalClearResponse } from "./generated/v2/ThreadGoalClearResponse";
import type { ThreadGoalGetParams } from "./generated/v2/ThreadGoalGetParams";
import type { ThreadGoalGetResponse } from "./generated/v2/ThreadGoalGetResponse";
import type { ThreadGoalSetParams } from "./generated/v2/ThreadGoalSetParams";
import type { ThreadGoalSetResponse } from "./generated/v2/ThreadGoalSetResponse";
import type { ThreadItemsListParams } from "./generated/v2/ThreadItemsListParams";
import type { ThreadItemsListResponse } from "./generated/v2/ThreadItemsListResponse";
import type { ThreadLoadedListParams } from "./generated/v2/ThreadLoadedListParams";
import type { ThreadLoadedListResponse } from "./generated/v2/ThreadLoadedListResponse";
import type { ThreadListParams } from "./generated/v2/ThreadListParams";
import type { ThreadListResponse } from "./generated/v2/ThreadListResponse";
import type { ThreadReadParams } from "./generated/v2/ThreadReadParams";
import type { ThreadReadResponse } from "./generated/v2/ThreadReadResponse";
import type { ThreadRollbackParams } from "./generated/v2/ThreadRollbackParams";
import type { ThreadRollbackResponse } from "./generated/v2/ThreadRollbackResponse";
import type { ThreadSearchOccurrencesParams } from "./generated/v2/ThreadSearchOccurrencesParams";
import type { ThreadSearchOccurrencesResponse } from "./generated/v2/ThreadSearchOccurrencesResponse";
import type { ThreadSearchParams } from "./generated/v2/ThreadSearchParams";
import type { ThreadSearchResponse } from "./generated/v2/ThreadSearchResponse";
import type { ThreadSetNameParams } from "./generated/v2/ThreadSetNameParams";
import type { ThreadSetNameResponse } from "./generated/v2/ThreadSetNameResponse";
import type { ThreadTurnsListParams } from "./generated/v2/ThreadTurnsListParams";
import type { ThreadTurnsListResponse } from "./generated/v2/ThreadTurnsListResponse";
import type { ThreadUnarchiveParams } from "./generated/v2/ThreadUnarchiveParams";
import type { ThreadUnarchiveResponse } from "./generated/v2/ThreadUnarchiveResponse";

type Request = (method: string, params?: unknown) => Promise<unknown>;

/** Typed client methods for the Codex-native lifecycle and history surface.
 * Keeping these beside the generated pin makes parameter drift a compile error
 * while the runtime's generic request remains available for experimental RPCs. */
export function createCodexThreadClient(request: Request) {
  const call = <T>(method: string, params: unknown): Promise<T> =>
    request(method, params) as Promise<T>;

  return {
    forkThread: (params: ThreadForkParams) =>
      call<ThreadForkResponse>("thread/fork", params),
    archiveThread: (params: ThreadArchiveParams) =>
      call<ThreadArchiveResponse>("thread/archive", params),
    unarchiveThread: (params: ThreadUnarchiveParams) =>
      call<ThreadUnarchiveResponse>("thread/unarchive", params),
    deleteThread: (params: ThreadDeleteParams) =>
      call<ThreadDeleteResponse>("thread/delete", params),
    setThreadName: (params: ThreadSetNameParams) =>
      call<ThreadSetNameResponse>("thread/name/set", params),
    setThreadGoal: (params: ThreadGoalSetParams) =>
      call<ThreadGoalSetResponse>("thread/goal/set", params),
    getThreadGoal: (params: ThreadGoalGetParams) =>
      call<ThreadGoalGetResponse>("thread/goal/get", params),
    clearThreadGoal: (params: ThreadGoalClearParams) =>
      call<ThreadGoalClearResponse>("thread/goal/clear", params),
    listThreads: (params: ThreadListParams) =>
      call<ThreadListResponse>("thread/list", params),
    readThread: (params: ThreadReadParams) =>
      call<ThreadReadResponse>("thread/read", params),
    listThreadTurns: (params: ThreadTurnsListParams) =>
      call<ThreadTurnsListResponse>("thread/turns/list", params),
    listThreadItems: (params: ThreadItemsListParams) =>
      call<ThreadItemsListResponse>("thread/items/list", params),
    searchThreads: (params: ThreadSearchParams) =>
      call<ThreadSearchResponse>("thread/search", params),
    searchThreadOccurrences: (params: ThreadSearchOccurrencesParams) =>
      call<ThreadSearchOccurrencesResponse>("thread/searchOccurrences", params),
    listLoadedThreads: (params: ThreadLoadedListParams) =>
      call<ThreadLoadedListResponse>("thread/loaded/list", params),
    listBackgroundTerminals: (params: ThreadBackgroundTerminalsListParams) =>
      call<ThreadBackgroundTerminalsListResponse>("thread/backgroundTerminals/list", params),
    cleanBackgroundTerminals: (params: ThreadBackgroundTerminalsCleanParams) =>
      call<ThreadBackgroundTerminalsCleanResponse>("thread/backgroundTerminals/clean", params),
    terminateBackgroundTerminal: (params: ThreadBackgroundTerminalsTerminateParams) =>
      call<ThreadBackgroundTerminalsTerminateResponse>("thread/backgroundTerminals/terminate", params),
    rollbackThread: (params: ThreadRollbackParams) =>
      call<ThreadRollbackResponse>("thread/rollback", params),
  };
}

export type CodexThreadClient = ReturnType<typeof createCodexThreadClient>;
