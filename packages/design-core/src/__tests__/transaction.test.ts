import { describe, expect, it } from "vitest";
import {
  applyDesignTransaction,
  canonicalDesignJson,
  DesignTransactionConflictError,
  DesignTransactionDocumentError,
} from "../transaction";
import {
  TEST_ADAPTER,
  testState,
  textOperation,
  transaction,
} from "./test-adapter";

describe("applyDesignTransaction", () => {
  it("applies a batch atomically and returns reverse-ordered inverses", () => {
    const initial = testState();
    const outcome = applyDesignTransaction(
      initial,
      transaction(initial, "transaction-1", [
        textOperation("operation-1", "first", "updated first"),
        textOperation("operation-2", "second", "updated second"),
      ]),
      TEST_ADAPTER,
    );

    expect(initial.nodes).toEqual({ first: "one", second: "two" });
    expect(outcome.state.nodes).toEqual({
      first: "updated first",
      second: "updated second",
    });
    expect(
      outcome.inverseOperations.map((operation) => operation.operationId),
    ).toEqual(["inverse:operation-2", "inverse:operation-1"]);
    expect(outcome.receipt).toMatchObject({
      status: "applied",
      beforeRevision: "revision-0",
      afterRevision: "revision-2",
      affectedNodeIds: ["first", "second"],
      affectedFiles: ["index.html"],
    });
  });

  it("does not expose a partial state when a later operation fails", () => {
    const initial = testState();
    expect(() =>
      applyDesignTransaction(
        initial,
        transaction(initial, "transaction-1", [
          textOperation("operation-1", "first", "updated"),
          textOperation("operation-2", "missing", "failure"),
        ]),
        TEST_ADAPTER,
      ),
    ).toThrow("Unknown node: missing");
    expect(initial).toEqual(testState());
  });

  it("rejects a changed adapter result that cannot be inverted", () => {
    const initial = testState();
    expect(() =>
      applyDesignTransaction(
        initial,
        transaction(initial, "missing-inverse", [
          textOperation("operation-1", "first", "updated"),
        ]),
        {
          ...TEST_ADAPTER,
          apply(state, operation) {
            const result = TEST_ADAPTER.apply(state, operation);
            return { ...result, inverse: [] };
          },
        },
      ),
    ).toThrow("must provide an inverse");
    expect(initial).toEqual(testState());
  });

  it("rejects stale revisions and the wrong document", () => {
    const initial = testState();
    expect(() =>
      applyDesignTransaction(
        initial,
        transaction(
          initial,
          "stale",
          [textOperation("operation-1", "first", "updated")],
          { baseRevision: "revision-99" },
        ),
        TEST_ADAPTER,
      ),
    ).toThrow(DesignTransactionConflictError);
    expect(() =>
      applyDesignTransaction(
        initial,
        transaction(
          initial,
          "wrong-document",
          [textOperation("operation-1", "first", "updated")],
          { documentId: "document-2" },
        ),
        TEST_ADAPTER,
      ),
    ).toThrow(DesignTransactionDocumentError);
  });

  it("canonicalizes object keys for stable idempotency signatures", () => {
    expect(canonicalDesignJson({ b: 2, a: [true, null] })).toBe(
      '{"a":[true,null],"b":2}',
    );
    expect(canonicalDesignJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
