import { describe, expect, it, vi } from "vitest";
import { ProviderCredentialSync } from "../provider-credential-sync";

describe("private engine credential acknowledgment", () => {
  it("waits for the exact request and engine generation before finishing a switch", async () => {
    const sync = new ProviderCredentialSync();
    const child = {};
    const writes: string[] = [];
    const done = vi.fn();
    const sending = sync.send(child, (id) => writes.push(id)).then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    sync.acknowledge(
      {},
      { type: "engine.providerCredentialsApplied", requestId: writes[0] },
    );
    sync.acknowledge(child, {
      type: "engine.providerCredentialsApplied",
      requestId: "stale",
    });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    sync.acknowledge(child, {
      type: "engine.providerCredentialsApplied",
      requestId: writes[0],
    });
    await sending;
    expect(done).toHaveBeenCalledOnce();
  });
  it("bounds a lost acknowledgment and hides write errors", async () => {
    vi.useFakeTimers();
    try {
      const sync = new ProviderCredentialSync();
      const sending = sync.send({}, () => {});
      const rejected = expect(sending).rejects.toThrow("did not confirm");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      await expect(
        sync.send({}, () => {
          throw new Error("private credential");
        }),
      ).rejects.toThrow("engine connection changed");
    } finally {
      vi.useRealTimers();
    }
  });
});
