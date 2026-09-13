import { describe, expect, it, vi } from "vitest";
import {
  ProviderSubscriptionController,
  type SubscriptionDriver,
} from "../provider-subscription-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const driver: SubscriptionDriver = {
    read: vi.fn().mockResolvedValue({ state: "disconnected" }),
    login: vi
      .fn()
      .mockResolvedValue({ state: "connected", email: "user@example.test" }),
  };
  const publish = vi.fn();
  const controller = new ProviderSubscriptionController(
    "claude",
    driver,
    publish,
  );
  return { driver, controller, publish };
}

describe("native provider subscription connection", () => {
  it("stops a failure-recovery probe when the app quits", async () => {
    const { driver, controller } = fixture();
    vi.mocked(driver.login).mockRejectedValue(new Error("failed"));
    let readSignal: AbortSignal | undefined;
    vi.mocked(driver.read).mockImplementation((signal) => {
      readSignal = signal;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("stopped")), {
          once: true,
        }),
      );
    });
    controller.connect();
    await vi.waitFor(() => expect(readSignal).toBeDefined());
    const stop = controller.dispose();
    expect(readSignal!.aborted).toBe(true);
    await stop;
  });

  it("acknowledges immediately, deduplicates, and publishes only confirmed account metadata", async () => {
    const { driver, controller, publish } = fixture();
    const done = deferred<{ state: "connected"; email: string }>();
    vi.mocked(driver.login).mockReturnValue(done.promise);
    const first = controller.connect();
    expect(first).toMatchObject({ provider: "claude", state: "connecting" });
    expect(controller.connect().attemptId).toBe(first.attemptId);
    await Promise.resolve();
    expect(driver.login).toHaveBeenCalledOnce();
    done.resolve({ state: "connected", email: "user@example.test" });
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: "connected" }),
      ),
    );
    expect((await controller.status()).state).toBe("disconnected"); // a fresh native read, not a permanent optimistic success
  });

  it("does not let an older status read overwrite an active login", async () => {
    const { driver, controller } = fixture();
    const read = deferred<{ state: "disconnected" }>();
    const login = deferred<{ state: "connected" }>();
    vi.mocked(driver.read).mockReturnValue(read.promise);
    vi.mocked(driver.login).mockReturnValue(login.promise);
    const old = controller.status();
    const started = controller.connect();
    read.resolve({ state: "disconnected" });
    expect(await old).toMatchObject({
      state: "connecting",
      attemptId: started.attemptId,
    });
    login.resolve({ state: "connected" });
    await controller.dispose();
  });

  it("drains a canceled login before admitting another and ignores stale cancellation", async () => {
    const { driver, controller } = fixture();
    const login = deferred<{ state: "connected" }>();
    vi.mocked(driver.login).mockReturnValue(login.promise);
    const started = controller.connect();
    await Promise.resolve();
    const canceled = controller.cancel(started.attemptId!);
    expect(vi.mocked(driver.login).mock.calls[0][0].signal.aborted).toBe(true);
    expect(controller.connect().attemptId).toBe(started.attemptId);
    login.resolve({ state: "connected" });
    expect(await canceled).toMatchObject({
      state: "disconnected",
      error: "Sign-in canceled.",
    });
    vi.mocked(driver.login).mockImplementation(
      ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        ),
    );
    const next = controller.connect();
    expect(next.attemptId).not.toBe(started.attemptId);
    await controller.cancel(started.attemptId!);
    expect((await controller.status()).attemptId).toBe(next.attemptId);
    await Promise.resolve();
    await controller.dispose();
  });

  it("keeps the actual account after a failed replacement and redacts provider failures", async () => {
    const { driver, controller, publish } = fixture();
    vi.mocked(driver.read).mockResolvedValue({
      state: "connected",
      email: "existing@example.test",
    });
    vi.mocked(driver.login).mockRejectedValue(
      new Error("private-auth-response"),
    );
    controller.connect();
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: "connected",
          email: "existing@example.test",
          error: expect.any(String),
        }),
      ),
    );
    expect(JSON.stringify(publish.mock.calls)).not.toContain(
      "private-auth-response",
    );
  });

  it("accepts a manual Claude code only for the matching, ready login attempt", async () => {
    const { driver, controller } = fixture();
    const submit = vi.fn();
    vi.mocked(driver.login).mockImplementation(({ signal, onCodeRequired }) => {
      onCodeRequired(submit);
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    });
    const started = controller.connect();
    await Promise.resolve();
    expect((await controller.status()).canSubmitCode).toBe(true);
    expect(() => controller.submitCode("stale", "sample-code")).toThrow(
      /no longer/,
    );
    controller.submitCode(started.attemptId!, "sample-code");
    expect(submit).toHaveBeenCalledExactlyOnceWith("sample-code");
    expect(() => controller.submitCode(started.attemptId!, "again")).toThrow(
      /no longer/,
    );
    await controller.dispose();
  });
});
