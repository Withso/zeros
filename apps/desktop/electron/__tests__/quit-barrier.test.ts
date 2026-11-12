import { afterEach, expect, it } from "vitest";
import { holdQuitFor, resetQuitBarrierForTests, runQuitSteps } from "../quit-barrier";

afterEach(() => { resetQuitBarrierForTests(); });

it("waits for every registered step, and a failing step never blocks the quit", async () => {
  const order: string[] = [];
  let finish!: () => void;
  holdQuitFor(() => new Promise<void>(resolve => { finish = () => { order.push("slow"); resolve(); }; }));
  holdQuitFor(async () => { throw new Error("broken"); });
  let done = false;
  const quit = runQuitSteps().then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(done).toBe(false);
  finish(); await quit;
  expect(order).toEqual(["slow"]);
});
