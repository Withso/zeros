import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CloudProviderAuthController,
  type CloudProviderAuthMaterial,
} from "../cloud-provider-auth-controller";

function fixture() {
  let session: { sub: string; accessToken: string } | null = {
    sub: "owner-a",
    accessToken: "private-zeros-token",
  };
  let finish!: (value: CloudProviderAuthMaterial) => void;
  const login = vi.fn(
    () =>
      new Promise<CloudProviderAuthMaterial>((resolve) => {
        finish = resolve;
      }),
  );
  const id = randomUUID();
  const save = vi.fn(async () => ({
    id,
    kind: "codex-chatgpt",
    displayName: "Subscription",
    revision: 1,
    revoked: false,
  }));
  const controller = new CloudProviderAuthController({
    session: async () => session,
    login,
    save,
  });
  const request = {
    action: "connect" as const,
    attemptId: randomUUID(),
    organizationId: randomUUID(),
    provider: "codex" as const,
    displayName: "Subscription",
  };
  const done = () => finish({ nativeCache: { private: "provider-secret" } });
  return {
    controller,
    request,
    save,
    login,
    done,
    setSession: (next: typeof session) => {
      session = next;
    },
  };
}
describe("cloud provider sign-in ownership", () => {
  it("distinguishes cloud import failure from browser sign-in without exposing upstream errors", async () => {
    const reportFailure = vi.fn();
    const controller = new CloudProviderAuthController({
      session: async () => ({ sub: "owner", accessToken: "private-zeros-token" }),
      login: async () => ({ nativeCache: { private: "provider-secret" } }),
      save: async () => { throw new Error("upstream provider-secret private-zeros-token"); },
      reportFailure,
    });
    const request = { action: "connect" as const, attemptId: randomUUID(), organizationId: randomUUID(), provider: "codex" as const, displayName: "Account" };
    await controller.request(request, 7);
    await vi.waitFor(async () => {
      const status = await controller.request({ action: "status", attemptId: request.attemptId }, 7);
      expect(status.state).toBe("failed");
      expect(status.error).toMatch(/signed in.*save/i);
      expect(JSON.stringify(status)).not.toMatch(/provider-secret|private-zeros-token/);
    });
    expect(reportFailure).toHaveBeenCalledWith({ provider: "codex", phase: "cloud-save" });
    await controller.stop();
  });
  it("deduplicates retries and returns metadata without native material", async () => {
    const f = fixture();
    await f.controller.request(f.request, 7);
    await f.controller.request(f.request, 7);
    expect(f.login).toHaveBeenCalledTimes(1);
    f.done();
    await vi.waitFor(async () =>
      expect(
        (
          await f.controller.request(
            { action: "status", attemptId: f.request.attemptId },
            7,
          )
        ).state,
      ).toBe("connected"),
    );
    const status = await f.controller.request(
      { action: "status", attemptId: f.request.attemptId },
      7,
    );
    expect(JSON.stringify(status)).not.toMatch(
      /provider-secret|private-zeros-token|nativeCache/,
    );
    expect(f.save).toHaveBeenCalledTimes(1);
    await f.controller.stop();
  });
  it("cannot hand a ceremony to another window or Zeros account", async () => {
    const f = fixture();
    await f.controller.request(f.request, 7);
    await expect(
      f.controller.request(
        { action: "status", attemptId: f.request.attemptId },
        8,
      ),
    ).rejects.toThrow();
    f.setSession({ sub: "owner-b", accessToken: "other-private-token" });
    f.done();
    await vi.waitFor(() => expect(f.save).not.toHaveBeenCalled());
    await f.controller.stop();
    expect(f.save).not.toHaveBeenCalled();
  });
  it("does not upload a token after cancellation and removes the device code", async () => {
    const f = fixture();
    await f.controller.request(f.request, 7);
    const cancel = f.controller.request(
      { action: "cancel", attemptId: f.request.attemptId },
      7,
    );
    await Promise.resolve();
    f.done();
    expect(await cancel).toMatchObject({ state: "canceled" });
    expect(f.save).not.toHaveBeenCalled();
    await f.controller.stop();
  });
  it("does not activate an upload that completes after cancellation", async () => {
    const f = fixture();
    let upload!: () => void;
    f.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          upload = () =>
            resolve({
              id: randomUUID(),
              kind: "codex-chatgpt",
              displayName: "Subscription",
              revision: 1,
              revoked: false,
            });
        }),
    );
    await f.controller.request(f.request, 7);
    f.done();
    await vi.waitFor(() => expect(f.save).toHaveBeenCalled());
    const cancel = f.controller.request(
      { action: "cancel", attemptId: f.request.attemptId },
      7,
    );
    await Promise.resolve();
    upload();
    expect(await cancel).toMatchObject({ state: "canceled" });
    await f.controller.stop();
  });
});
