import type {
  DesignActor,
  DesignOperation,
  DesignTransaction,
} from "../schema";
import type { DesignTransactionAdapter } from "../transaction";

export interface TestDesignState {
  documentId: string;
  revision: number;
  nodes: Readonly<Record<string, string>>;
}

export const TEST_ACTOR: DesignActor = {
  kind: "human",
  id: "tester",
};

export const TEST_ADAPTER: DesignTransactionAdapter<TestDesignState> = {
  documentId: (state) => state.documentId,
  revision: (state) => `revision-${state.revision}`,
  apply: (state, operation) => {
    if (operation.type !== "node.set-text") {
      throw new Error(`Unsupported test operation: ${operation.type}`);
    }
    const previous = state.nodes[operation.nodeId];
    if (previous === undefined) {
      throw new Error(`Unknown node: ${operation.nodeId}`);
    }
    const changed = previous !== operation.text;
    return {
      state: changed
        ? {
            ...state,
            revision: state.revision + 1,
            nodes: { ...state.nodes, [operation.nodeId]: operation.text },
          }
        : state,
      changed,
      inverse: {
        operationId: `inverse:${operation.operationId}`,
        type: "node.set-text",
        nodeId: operation.nodeId,
        text: previous,
      },
      affectedNodeIds: [operation.nodeId],
      affectedFiles: ["index.html"],
    };
  },
};

export function testState(): TestDesignState {
  return {
    documentId: "document-1",
    revision: 0,
    nodes: { first: "one", second: "two" },
  };
}

export function textOperation(
  operationId: string,
  nodeId: string,
  text: string,
): DesignOperation {
  return {
    operationId,
    type: "node.set-text",
    nodeId,
    text,
  };
}

export function transaction(
  state: TestDesignState,
  transactionId: string,
  operations: DesignOperation[],
  overrides: Partial<DesignTransaction> = {},
): DesignTransaction {
  return {
    schemaVersion: 1,
    transactionId,
    documentId: state.documentId,
    baseRevision: TEST_ADAPTER.revision(state),
    actor: TEST_ACTOR,
    intent: `Apply ${transactionId}`,
    createdAt: state.revision * 100,
    operations,
    ...overrides,
  };
}
