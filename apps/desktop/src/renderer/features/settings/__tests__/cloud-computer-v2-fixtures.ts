import type {
  CloudComputerV2BuildSummary,
  CloudComputerV2State,
} from "@zeros/protocol/cloud-computer-v2";

export const computerOrg = "11111111-1111-4111-8111-111111111111";
export const otherComputerOrg = "33333333-3333-4333-8333-333333333333";
export const computerBuildId = "22222222-2222-4222-8222-222222222222";
export const computerOperationId = "66666666-6666-4666-8666-666666666666";
export const computerUser = "44444444-4444-4444-8444-444444444444";

export function computerBuild(
  overrides: Partial<CloudComputerV2BuildSummary> = {},
): CloudComputerV2BuildSummary {
  return {
    id: computerBuildId,
    version: 1,
    configId: computerOperationId,
    acceptedRevision: 1,
    state: "succeeded",
    stage: "done",
    errorCode: null,
    rebuiltFromBuildId: null,
    templateState: "ready",
    createdAt: "2026-10-04T10:00:00.000Z",
    startedAt: "2026-10-04T10:00:01.000Z",
    completedAt: "2026-10-04T10:00:10.000Z",
    cancelRequestedAt: null,
    ...overrides,
  };
}

export function computerState(
  overrides: Partial<CloudComputerV2State> = {},
): CloudComputerV2State {
  return {
    state: "not_built",
    revision: 0,
    draft: {
      configId: null,
      repositories: [],
      installScript: "",
      timeoutSeconds: 900,
      environment: [],
    },
    active: null,
    previous: null,
    latestBuild: null,
    unbuiltChanges: false,
    history: { builds: [], nextCursor: null },
    canManage: true,
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
