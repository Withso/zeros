import { describe, expect, it } from "vitest";
import { DesignTransactionSession } from "../history";
import {
  DesignTransactionIdReuseError,
  type DesignTransactionAdapter,
} from "../transaction";
import {
  TEST_ACTOR,
  TEST_ADAPTER,
  type TestDesignState,
  testState,
  textOperation,
  transaction,
} from "./test-adapter";

describe("DesignTransactionSession", () => {
  it("deduplicates retries and rejects transaction-id reuse", () => {
    const initial = testState();
    const session = new DesignTransactionSession(initial, TEST_ADAPTER);
    const input = transaction(initial, "transaction-1", [
      textOperation("operation-1", "first", "updated"),
    ]);
    expect(session.apply(input).receipt.status).toBe("applied");
    expect(session.apply(input).receipt.status).toBe("duplicate");
    expect(session.currentState().revision).toBe(1);
    expect(() =>
      session.apply({
        ...input,
        operations: [textOperation("operation-1", "first", "different")],
      }),
    ).toThrow(DesignTransactionIdReuseError);
  });

  it("coalesces one gesture into one undo step and supports redo", () => {
    const initial = testState();
    const session = new DesignTransactionSession(initial, TEST_ADAPTER, {
      coalesceWindowMs: 1_000,
      now: () => 10_000,
    });
    const first = session.apply(
      transaction(
        initial,
        "drag-1",
        [textOperation("operation-1", "first", "intermediate")],
        { coalesceKey: "text-drag", createdAt: 100 },
      ),
    );
    session.apply(
      transaction(
        first.state,
        "drag-2",
        [textOperation("operation-2", "first", "final")],
        { coalesceKey: "text-drag", createdAt: 200 },
      ),
    );

    expect(session.status()).toMatchObject({ undoDepth: 1, redoDepth: 0 });
    expect(session.undo()?.state.nodes.first).toBe("one");
    expect(session.status()).toMatchObject({ undoDepth: 0, redoDepth: 1 });
    expect(session.redo()?.state.nodes.first).toBe("final");
  });

  it("keeps coalesced history transactions within the public operation bound", () => {
    const initial = testState();
    const session = new DesignTransactionSession(initial, TEST_ADAPTER, {
      coalesceWindowMs: 60_000,
      maxEntries: 300,
    });
    let current = initial;
    for (let index = 0; index < 257; index += 1) {
      current = session.apply(
        transaction(
          current,
          `coalesced-${index}`,
          [textOperation(`operation-${index}`, "first", `value-${index}`)],
          { coalesceKey: "continuous-edit", createdAt: index },
        ),
      ).state;
    }

    expect(session.status().undoDepth).toBe(2);
    expect(session.undo()?.state.nodes.first).toBe("value-255");
    expect(session.undo()?.state.nodes.first).toBe("one");
  });

  it("generates bounded internal history ids for maximum-length caller ids", () => {
    const initial = testState();
    const session = new DesignTransactionSession(initial, TEST_ADAPTER);
    const transactionId = `t${"x".repeat(255)}`;
    session.apply({
      ...transaction(initial, transactionId, [
        textOperation(`o${"x".repeat(255)}`, "first", "updated"),
      ]),
      intent: "x".repeat(1_000),
    });

    expect(session.undo()?.state.nodes.first).toBe("one");
    expect(session.redo()?.state.nodes.first).toBe("updated");
  });

  it("atomically chunks a bounded entry whose generated inverses exceed 256 operations", () => {
    const adapter: DesignTransactionAdapter<TestDesignState> = {
      ...TEST_ADAPTER,
      apply(state, operation) {
        const result = TEST_ADAPTER.apply(state, operation);
        const inverse = Array.isArray(result.inverse)
          ? result.inverse[0]!
          : result.inverse;
        return {
          ...result,
          inverse: [
            inverse,
            { ...inverse, operationId: `${inverse.operationId}:duplicate` },
          ],
        };
      },
    };
    const initial = testState();
    const session = new DesignTransactionSession(initial, adapter);
    const operations = Array.from({ length: 129 }, (_, index) =>
      textOperation(`operation-${index}`, "first", `value-${index}`),
    );
    session.apply(transaction(initial, "multi-inverse", operations));

    expect(session.undo()?.state.nodes.first).toBe("one");
    expect(session.redo()?.state.nodes.first).toBe("value-128");
  });

  it("accounts for retained redo memory and releases it on a divergent edit", () => {
    const initial = testState();
    const session = new DesignTransactionSession(initial, TEST_ADAPTER);
    session.apply(
      transaction(initial, "large-edit", [
        textOperation("large-operation", "first", "x".repeat(1_500)),
      ]),
    );
    const retainedBeforeUndo = session.status().retainedBytes;
    expect(retainedBeforeUndo).toBeGreaterThan(0);

    session.undo();
    expect(session.status().retainedBytes).toBe(retainedBeforeUndo);

    const stateAfterUndo = session.currentState();
    session.apply(
      transaction(stateAfterUndo, "divergent-edit", [
        textOperation("small-operation", "second", "changed"),
      ]),
    );
    expect(session.status()).toMatchObject({ redoDepth: 0, undoDepth: 1 });
    expect(session.status().retainedBytes).toBeLessThan(retainedBeforeUndo);
  });

  it("bounds undo entries and refuses an actor-mismatched undo", () => {
    const initial = testState();
    const session = new DesignTransactionSession(initial, TEST_ADAPTER, {
      maxEntries: 2,
    });
    let state = initial;
    for (let index = 0; index < 3; index += 1) {
      const outcome = session.apply(
        transaction(state, `transaction-${index}`, [
          textOperation(`operation-${index}`, "first", `value-${index}`),
        ]),
      );
      state = outcome.state;
    }
    expect(session.status().undoDepth).toBe(2);
    expect(session.undo({ kind: "agent", id: "different-actor" })).toBeNull();
    expect(session.undo(TEST_ACTOR)?.state.nodes.first).toBe("value-1");
  });

  it("retains history for the exact revision and clears it on external edits", () => {
    const initial = testState();
    const session = new DesignTransactionSession(initial, TEST_ADAPTER);
    const outcome = session.apply(
      transaction(initial, "transaction-1", [
        textOperation("operation-1", "first", "updated"),
      ]),
    );
    expect(session.reconcile({ ...outcome.state }, "same snapshot")).toEqual({
      changed: false,
      historyCleared: false,
    });
    expect(session.status().canUndo).toBe(true);

    const external = {
      ...outcome.state,
      revision: outcome.state.revision + 1,
      nodes: { ...outcome.state.nodes, first: "external" },
    };
    expect(session.reconcile(external, "Git worktree changed")).toEqual({
      changed: true,
      historyCleared: true,
    });
    expect(session.status()).toMatchObject({
      canUndo: false,
      canRedo: false,
      retainedBytes: 0,
      lastReconciliationReason: "Git worktree changed",
    });
  });

  it("bounds retained idempotency signatures by bytes as well as count", () => {
    const initial = testState();
    const session = new DesignTransactionSession(initial, TEST_ADAPTER, {
      maxReceipts: 100,
      maxReceiptBytes: 4_096,
    });
    let current = initial;
    for (let index = 0; index < 20; index += 1) {
      current = session.apply(
        transaction(current, `receipt-${index}`, [
          textOperation(
            `receipt-operation-${index}`,
            "first",
            `value-${index}-${"x".repeat(120)}`,
          ),
        ]),
      ).state;
    }

    expect(session.status().retainedReceiptBytes).toBeGreaterThan(0);
    expect(session.status().retainedReceiptBytes).toBeLessThanOrEqual(4_096);
  });
});
