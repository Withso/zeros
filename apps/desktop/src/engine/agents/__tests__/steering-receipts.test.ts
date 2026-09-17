import { describe, expect, it, vi } from "vitest";
import { SteeringReceipts } from "../steering-receipts";

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
    for (let i = 0; i < 256; i++)
      await ledger.run("execution", String(i), deliver);
    await expect(ledger.run("execution", "overflow", deliver)).rejects.toThrow(
      "Steering receipt capacity",
    );
    await expect(ledger.run("execution", "0", deliver)).resolves.toBe(
      "delivered",
    );
    expect(deliver).toHaveBeenCalledTimes(256);
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
