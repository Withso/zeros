import { expect, it } from "vitest";
import { DesignEvidenceBudget } from "../evidence-budget";
it("rejects excess jobs without queueing and releases nested/cancelled ownership", async () => {
  const budget = new DesignEvidenceBudget(1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = budget
    .run(async () => {
      await budget.run(async () => 1);
      await held;
      throw new Error("cancelled");
    })
    .catch((error) => error);
  await expect(budget.run(async () => "extra")).rejects.toThrow(/capacity/);
  release();
  await first;
  expect(await budget.run(async () => "recovered")).toBe("recovered");
});
it("does not retain admission through a detached async continuation", async () => {
  const budget = new DesignEvidenceBudget(1);
  let runLate!: () => Promise<string>;
  await budget.run(async () => {
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    // Start the continuation inside the owner context, then resume only after
    // that owner has returned and another job has consumed the available slot.
    const detached = (async () => {
      await waiting;
      return budget.run(async () => "late");
    })();
    runLate = () => {
      resume();
      return detached;
    };
  });
  let release!: () => void;
  const flight = budget.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await expect(runLate()).rejects.toThrow(/capacity/);
  release();
  await flight;
});
