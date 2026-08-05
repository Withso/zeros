import { afterEach, describe, expect, it, vi } from "vitest";

const nativeInvoke = vi.hoisted(() => vi.fn());

vi.mock("../../runtime", () => ({
  isNativeRuntime: () => true,
  nativeInvoke,
}));

import { wireGithubCredentialWriteback } from "../github-token-sync";
import { ghAuthStatusCache } from "../../../state/read-caches";
import type { RuntimeClient } from "../ws-client";

describe("GitHub credential writeback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    nativeInvoke.mockReset();
  });

  it("revalidates after main has recorded an engine rejection", async () => {
    let finish!: () => void;
    nativeInvoke.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    let onChange!: (message: unknown) => void;
    const bridge = {
      on: vi.fn((_type: string, listener: (message: unknown) => void) => {
        onChange = listener;
        return vi.fn();
      }),
    } as unknown as RuntimeClient;
    const invalidate = vi.spyOn(ghAuthStatusCache, "invalidateAll");

    wireGithubCredentialWriteback(bridge);
    onChange({ method: "pat", reason: "credential-invalid" });

    expect(invalidate).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve();
    await Promise.resolve();

    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
