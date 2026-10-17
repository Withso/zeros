import { describe, expect, it, vi } from "vitest";
import { STEERING_RECEIPT_CAPACITY, SteeringReceipts } from "../steering-receipts";

describe("steering request receipts", () => {
  it("shares in-flight delivery and replays its terminal acknowledgement exactly once", async () => {
    const ledger = new SteeringReceipts<string>();
    let finish!: (value: string) => void;
    const deliver = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const first = ledger.run("execution", "message", deliver);
    const retry = ledger.run("execution", "message", deliver);
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledTimes(1);
    finish("delivered");
    await expect(retry).resolves.toBe("delivered");
    expect(first).toBe(retry);
    await expect(ledger.run("execution", "message", deliver)).resolves.toBe(
      "delivered",
    );
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("keeps old acknowledgements at capacity instead of delivering a retry twice", async () => {
    const ledger = new SteeringReceipts<string>();
    const deliver = vi.fn(async () => "delivered");
    for (let i = 0; i < STEERING_RECEIPT_CAPACITY; i++)
      await ledger.run("execution", String(i), deliver);
    await expect(ledger.run("execution", "overflow", deliver)).rejects.toThrow(
      "Steering receipt capacity",
    );
    await expect(ledger.run("execution", "0", deliver)).resolves.toBe(
      "delivered",
    );
    expect(deliver).toHaveBeenCalledTimes(STEERING_RECEIPT_CAPACITY);
  });

  it("accepts thousands of steers in one long-lived execution and never forgets one", async () => {
    const ledger = new SteeringReceipts<string>();
    const deliver = vi.fn(async () => "delivered");
    for (let i = 0; i < 2_000; i++)
      await ledger.run("execution", String(i), deliver);
    expect(deliver).toHaveBeenCalledTimes(2_000);
    // The composer retries a lost steer by its exact id, however late.
    await expect(ledger.run("execution", "0", deliver)).resolves.toBe("delivered");
    expect(deliver).toHaveBeenCalledTimes(2_000);
    expect(STEERING_RECEIPT_CAPACITY).toBeGreaterThan(256);
  });

  it("isolates execution replacements and keeps failed receipt retries idempotent", async () => {
    const ledger = new SteeringReceipts<string>();
    const fail = vi.fn(async () => {
      throw new Error("lost delivery");
    });
    await expect(ledger.run("old", "message", fail)).rejects.toThrow(
      "lost delivery",
    );
    await expect(ledger.run("old", "message", fail)).rejects.toThrow(
      "lost delivery",
    );
    expect(fail).toHaveBeenCalledOnce();
    await expect(
      ledger.run("new", "message", async () => "queued"),
    ).resolves.toBe("queued");
    ledger.delete("old");
  });
});
