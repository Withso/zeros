import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BoatWorkspaceProvider } from "./boat-provider.js";
import type {
  CloudProviderOperationRecord,
  CloudProviderOperationStore,
} from "./provider-operation-store.js";
import { CloudProviderError, type CloudProviderCreateInput } from "./provider.js";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const RESOURCE = "bx_23456789";
const OPERATION = `bdop_${"a".repeat(32)}`;
const INPUT: CloudProviderCreateInput = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  generation: 1,
  imageRef: `boat:zeros-linux-qualified@sha256:${"a".repeat(64)}`,
  architecture: "linux/amd64",
  cpuMillicores: 4000,
  memoryMiB: 8192,
  storageMiB: 20480,
  idempotencyKey: "original-create-intent",
};
const WALLET = "team_0f5c2a9e-4b1d-4c8e-9a70-3d2b1e6f8c41";
const OTHER_WALLET = "team_9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
function sandbox(state = "ready", extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    sandbox: {
      id: RESOURCE,
      state,
      type: "default",
      snapshotAvailable: true,
      team: { id: WALLET, name: "Zeros" },
      ...extra,
    },
  };
}
function deletion(status = "processing", extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    operation: {
      id: OPERATION,
      kind: "sandbox",
      targetId: RESOURCE,
      status,
      completedAt: status === "completed" ? new Date(NOW).toISOString() : null,
      ...extra,
    },
  };
}
function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}
function rejectedCreate() {
  return json({
    ok: false, type: "sandbox.error", status: 429, code: "trial_compute_limit_reached", requestId: "req_test_rejected_create",
    error: { status: 429, code: "trial_compute_limit_reached" },
  }, 429);
}
// Member concurrent-cap refusal as observed from Boat on 2026-09-23.
function memberCapRefusal() {
  return json({
    ok: false, type: "sandbox.error", status: 429, code: "member_limit_reached", message: "member policy",
    requestId: "req_test_member_limit",
    error: { code: "member_limit_reached", message: "member policy", status: 429, details: {
      accessTier: "standard", maxActiveSandboxes: 100, canStart: true, status: "blocked",
      error: "member_limit_reached", activeSandboxes: 0, memberMaxActiveSandboxes: 0,
    } },
  }, 429);
}
const walletOf = (init?: RequestInit) => new Headers(init?.headers).get("x-boat-org");
const unreported = { team: undefined };
function fixture(extraOptions: { billingOrg?: string } = {}) {
  let stored: CloudProviderOperationRecord | null = null;
  const attempts = new Map<string, boolean>();
  const operations: CloudProviderOperationStore = {
    prepareCreate: vi.fn(async (input) => {
      if (stored && stored.requestSha256 !== input.requestSha256)
        throw new Error("conflicting body");
      stored ??= {
        ...input,
        createdAt: new Date(NOW),
        resourceId: null,
        deletionRequestedAt: null,
        deletionOperationId: null,
        deletedAt: null,
        createAttemptsTracked: true,
        createClosedAt: null,
        lostAt: null,
      };
      return { ...stored };
    }),
    beginCreateAttempt: vi.fn(async (_identity, id) => {
      if (stored?.createClosedAt)
        throw new CloudProviderError("provider_generation_retired", "Retired generation", false);
      if (!stored?.resourceId) attempts.set(id, false);
      return { ...stored! };
    }),
    recordCreateRejection: vi.fn(async (_identity, id) => {
      if (!attempts.has(id)) throw new Error("Missing dispatch");
      attempts.set(id, true);
    }),
    closeUnallocatedCreate: vi.fn(async () => {
      if (!stored?.createAttemptsTracked || stored.resourceId || [...attempts.values()].some(value => !value)) return false;
      stored.createClosedAt ??= new Date(NOW);
      return true;
    }),
    bindResource: vi.fn(async (_identity, id) => {
      stored!.resourceId = id;
      return { ...stored! };
    }),
    find: vi.fn(async () => (stored ? { ...stored } : null)),
    get: vi.fn(async (id) =>
      stored?.resourceId === id ? { ...stored } : null,
    ),
    beginDelete: vi.fn(async () => {
      stored!.deletionRequestedAt ??= new Date(NOW);
      return { ...stored! };
    }),
    bindDeletion: vi.fn(async (_resourceId, id) => {
      stored!.deletionOperationId = id;
    }),
    completeDeletion: vi.fn(async () => {
      stored!.deletedAt = new Date(NOW);
    }),
    list: vi.fn(async function* () {
      if (stored) yield { ...stored };
    }),
  };
  const access = {
    createSshAccess: vi.fn(),
    revokeSshAccess: vi.fn(async () => {}),
    getPreviewEndpoint: vi.fn(),
  };
  const fetcher = vi.fn<typeof fetch>();
  const options = {
    apiKey: "boat_coordinator-test-credential",
    timeoutMs: 1000,
    fetch: fetcher,
    operations,
    access,
    imageRef: INPUT.imageRef,
    qualifiedStorageMiB: INPUT.storageMiB,
    ttlSeconds: null,
    billingOrg: WALLET,
    now: () => NOW,
    ...extraOptions,
  };
  const provider = new BoatWorkspaceProvider(options);
  const allocate = async () => {
    fetcher.mockResolvedValueOnce(json(sandbox()));
    return provider.create(INPUT);
  };
  return {
    provider,
    fetcher,
    operations,
    access,
    options,
    allocate,
    stored: () => stored!,
  };
}

describe("Boat allocation lifecycle", () => {
  it("closes a rejected create after restart without inventing a resource or deletion receipt", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(rejectedCreate());
    await expect(f.provider.create(INPUT)).rejects.toMatchObject({ code: "provider_budget_exhausted" });
    const restarted = new BoatWorkspaceProvider(f.options);
    expect(await restarted.verifyAbsence(INPUT)).toBe(true);
    expect(f.stored().resourceId).toBeNull();
    expect(f.stored().deletedAt).toBeNull();
    await expect(restarted.create(INPUT)).rejects.toMatchObject({ code: "provider_generation_retired" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("closes a create refused by the member concurrent-sandbox cap", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(memberCapRefusal());
    await expect(f.provider.create(INPUT)).rejects.toMatchObject({ code: "provider_rate_limited", retryable: true });
    expect(await new BoatWorkspaceProvider(f.options).verifyAbsence(INPUT)).toBe(true);
    expect(f.stored().resourceId).toBeNull();
    await expect(f.provider.create(INPUT)).rejects.toMatchObject({ code: "provider_generation_retired" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("does not erase a lost create outcome when a later dispatch is rejected", async () => {
    const f = fixture();
    f.fetcher.mockRejectedValueOnce(new Error("lost reply"));
    await expect(f.provider.create(INPUT)).rejects.toThrow();
    f.fetcher.mockResolvedValueOnce(rejectedCreate());
    await expect(new BoatWorkspaceProvider(f.options).create(INPUT)).rejects.toThrow();
    expect(await f.provider.verifyAbsence(INPUT)).toBe(false);
  });

  it("does not erase an in-flight create when a concurrent dispatch is rejected", async () => {
    const f = fixture();
    let resolve!: (value: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r; }));
    const pending = f.provider.create(INPUT);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    f.fetcher.mockResolvedValueOnce(rejectedCreate());
    await expect(new BoatWorkspaceProvider(f.options).create(INPUT)).rejects.toThrow();
    expect(await f.provider.verifyAbsence(INPUT)).toBe(false);
    resolve(json(sandbox()));
    expect((await pending).resourceId).toBe(RESOURCE);
  });

  it("adopts an allocation bound between preparation and dispatch without another POST", async () => {
    const f=fixture();
    vi.mocked(f.operations.beginCreateAttempt).mockImplementationOnce(async () => {
      await f.operations.bindResource(INPUT,RESOURCE);
      return f.stored();
    });
    f.fetcher.mockResolvedValueOnce(json(sandbox()));
    expect((await f.provider.create(INPUT)).resourceId).toBe(RESOURCE);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0]![0]).toBe(`https://boat.dev/api/v1/sandboxes/${RESOURCE}`);
    expect(f.fetcher.mock.calls[0]![1]!.method).toBe("GET");
  });

  it("rejects mutable-only or invalid snapshot references before allocating", () => {
    const f = fixture();
    for (const imageRef of [
      "zeros-mutable",
      "latest@sha256:" + "a".repeat(64),
      "UPPERCASE@sha256:" + "a".repeat(64),
      "zeros@sha256:" + "a".repeat(63),
    ]) {
      expect(
        () => new BoatWorkspaceProvider({ ...f.options, imageRef }),
      ).toThrow(/snapshot/);
    }
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("records the create before dispatch and always supplies an explicit clean template, TTL and environment", async () => {
    const f = fixture();
    f.fetcher.mockImplementationOnce(async (_url, init) => {
      expect(f.stored().idempotencyKey).toBe(INPUT.idempotencyKey);
      expect(f.operations.beginCreateAttempt).toHaveBeenCalledOnce();
      expect(JSON.parse(String(init!.body))).toEqual({
        type: "default",
        from: "zeros-linux-qualified",
        ttlSeconds: null,
        noEnv: true,
        env: {},
      });
      expect(new Headers(init!.headers).get("idempotency-key")).toBe(
        INPUT.idempotencyKey,
      );
      return json(
        sandbox("provisioning", {
          desktopUrl: "https://secret.example/?token=private",
          setupError: "private source",
        }),
      );
    });
    const resource = await f.provider.create(INPUT);
    expect(resource).toMatchObject({
      resourceId: RESOURCE,
      workspaceId: INPUT.workspaceId,
      generation: 1,
      state: "provisioning",
    });
    expect(JSON.stringify(resource)).not.toContain("private");
    expect(f.stored().resourceId).toBe(RESOURCE);
  });

  it("bills every create dispatch to the configured wallet without changing its journaled request", async () => {
    const f = fixture();
    f.fetcher.mockRejectedValueOnce(new TypeError("reply lost"));
    await expect(f.provider.create(INPUT)).rejects.toMatchObject({ code: "provider_request_unavailable" });
    const restarted = new BoatWorkspaceProvider(f.options);
    f.fetcher.mockResolvedValueOnce(json(sandbox("provisioning")));
    await expect(restarted.create(INPUT)).resolves.toMatchObject({ resourceId: RESOURCE });
    const [first, retry] = f.fetcher.mock.calls.map(([, init]) => init!);
    for (const init of [first!, retry!]) {
      expect(walletOf(init)).toBe(WALLET);
      expect(new Headers(init.headers).get("idempotency-key")).toBe(INPUT.idempotencyKey);
      expect(JSON.parse(String(init.body))).not.toHaveProperty("org");
    }
    expect(retry!.body).toBe(first!.body);
    const body = JSON.parse(String(first!.body));
    expect(f.stored().requestSha256).toBe(createHash("sha256")
      .update(JSON.stringify({ imageRef: INPUT.imageRef, body, createAttemptJournalVersion: 1 })).digest("hex"));
  });

  it("does not let a changed wallet claim an allocation billed to the previous one", async () => {
    const f = fixture();
    await f.allocate();
    const moved = new BoatWorkspaceProvider({ ...f.options, billingOrg: OTHER_WALLET });
    f.fetcher.mockResolvedValueOnce(json(sandbox("running")));
    await expect(moved.create(INPUT)).rejects.toMatchObject({ code: "provider_billing_scope_mismatch" });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each([
    ["another organization", { team: { id: OTHER_WALLET, name: "Other" } }, "provider_billing_scope_mismatch"],
    ["the personal wallet", { team: null }, "provider_billing_scope_mismatch"],
    ["an unreported wallet", unreported, "provider_billing_scope_unconfirmed"],
  ])("keeps the cleanup identity but refuses a create billed to %s", async (_label, extra, code) => {
    const f = fixture();
    f.fetcher
      .mockResolvedValueOnce(json(sandbox("provisioning", extra)))
      .mockResolvedValueOnce(json(sandbox("provisioning", extra)));
    await expect(f.provider.create(INPUT)).rejects.toMatchObject({ code, retryable: false });
    expect(String(f.fetcher.mock.calls[1]![0])).toBe(`https://boat.dev/api/v1/sandboxes/${RESOURCE}`);
    expect(f.stored().resourceId).toBe(RESOURCE);
    expect(f.operations.bindResource).toHaveBeenCalledOnce();
  });

  it.each([unreported, { team: null }])("reads back an unconfirmed create wallet once before admitting it: %j", async (extra) => {
    const f = fixture();
    f.fetcher
      .mockResolvedValueOnce(json(sandbox("provisioning", extra)))
      .mockResolvedValueOnce(json(sandbox("provisioning")));
    await expect(f.provider.create(INPUT)).resolves.toMatchObject({ resourceId: RESOURCE });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("treats a malformed wallet as unconfirmed and a malformed sandbox as an invalid response", async () => {
    const f = fixture();
    f.fetcher
      .mockResolvedValueOnce(json(sandbox("provisioning", { team: { id: 7 } })))
      .mockResolvedValueOnce(json(sandbox("provisioning", { team: { id: 7 } })));
    await expect(f.provider.create(INPUT)).rejects.toMatchObject({ code: "provider_billing_scope_unconfirmed" });
    expect(f.stored().resourceId).toBe(RESOURCE);
    const g = fixture();
    g.fetcher
      .mockResolvedValueOnce(json(sandbox("unknown-state", { team: null })))
      .mockResolvedValueOnce(json(sandbox("unknown-state", { team: null })));
    await expect(g.provider.create(INPUT)).rejects.toMatchObject({ code: "provider_response_invalid" });
  });

  it("never reports live compute on an unconfirmed wallet, while Stop still applies", async () => {
    const f = fixture();
    await f.allocate();
    for (const extra of [{ team: { id: OTHER_WALLET, name: "Other" } }, { team: null }, unreported]) {
      f.fetcher.mockResolvedValueOnce(json(sandbox("running", extra)));
      await expect(f.provider.inspect(RESOURCE)).resolves.toMatchObject({ state: "failed", computeStopped: false });
    }
    f.fetcher.mockResolvedValueOnce(json(sandbox("archived", { lastSnapshotStatus: "completed", team: { id: OTHER_WALLET, name: "Other" } })));
    await expect(f.provider.inspect(RESOURCE)).resolves.toMatchObject({ state: "archived", computeStopped: true });
    f.fetcher.mockResolvedValueOnce(json(sandbox("running", { team: { id: WALLET.toUpperCase().replace("TEAM_", "team_"), name: "Zeros" } })));
    await expect(f.provider.inspect(RESOURCE)).resolves.toMatchObject({ state: "running" });
    f.fetcher
      .mockResolvedValueOnce(json(sandbox("running", { team: { id: OTHER_WALLET, name: "Other" } })))
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json(sandbox("archived", { lastSnapshotStatus: "completed", team: { id: OTHER_WALLET, name: "Other" } })));
    await expect(f.provider.stop(RESOURCE)).resolves.toMatchObject({ state: "archived" });
    expect(f.fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/stop") && init?.method === "POST")).toBe(true);
  });

  it("never grants compute to a mis-billed allocation on a create retry or resume, and refuses its renewal", async () => {
    const f = fixture();
    const misbilled = (state: string) => json(sandbox(state, { team: { id: OTHER_WALLET, name: "Other" } }));
    f.fetcher.mockResolvedValueOnce(misbilled("provisioning")).mockResolvedValueOnce(misbilled("provisioning"));
    await expect(f.provider.create(INPUT)).rejects.toMatchObject({ code: "provider_billing_scope_mismatch" });
    f.fetcher.mockResolvedValueOnce(misbilled("running"));
    await expect(f.provider.create(INPUT)).rejects.toMatchObject({ code: "provider_billing_scope_mismatch" });
    f.fetcher.mockResolvedValueOnce(misbilled("archived"));
    await expect(f.provider.start(RESOURCE)).rejects.toMatchObject({ code: "provider_billing_scope_mismatch" });
    const writes = f.fetcher.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
    expect(writes.map(([url, init]) => `${init!.method} ${String(url)}`)).toEqual(["POST https://boat.dev/api/v1/sandboxes"]);
    expect(f.operations.beginCreateAttempt).toHaveBeenCalledOnce();
    f.fetcher.mockResolvedValueOnce(misbilled("running")).mockResolvedValueOnce(misbilled("running"));
    await expect(f.provider.renewComputeLease(RESOURCE, 600)).rejects.toMatchObject({ code: "provider_billing_scope_mismatch" });
  });

  it("reuses the original provider key after an unknown reply, a new wake intent and a coordinator restart", async () => {
    const f = fixture();
    f.fetcher.mockRejectedValueOnce(
      new Error("connection reset with sensitive details"),
    );
    await expect(f.provider.create(INPUT)).rejects.toMatchObject({
      code: "provider_request_unavailable",
      retryable: true,
    });
    const restarted = new BoatWorkspaceProvider(f.options);
    f.fetcher.mockResolvedValueOnce(json(sandbox()));
    await restarted.create({ ...INPUT, idempotencyKey: "new-wake-intent" });
    const init = f.fetcher.mock.calls[1]![1]!;
    expect(new Headers(init.headers).get("idempotency-key")).toBe(
      INPUT.idempotencyKey,
    );
    expect(f.fetcher.mock.calls[0]![1]!.body).toBe(init.body);
  });

  it("does not issue another allocation after the finite provider retry window", async () => {
    const f = fixture();
    f.fetcher.mockRejectedValueOnce(new Error("lost reply"));
    await expect(f.provider.create(INPUT)).rejects.toThrow();
    const later = new BoatWorkspaceProvider({
      ...f.options,
      now: () => NOW + 24 * 60 * 60_000,
    });
    await expect(later.create(INPUT)).rejects.toMatchObject({
      code: "provider_create_outcome_unknown",
      retryable: false,
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains a cleanup identity when a create returns a malformed state", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(json(sandbox("unrecognized")));
    await expect(f.provider.create(INPUT)).rejects.toMatchObject({
      code: "provider_response_invalid",
    });
    expect(f.stored().resourceId).toBe(RESOURCE);
  });

  it.each([
    { architecture: "linux/arm64" },
    { cpuMillicores: 3000 },
    { memoryMiB: 4096 },
    { imageRef: "arbitrary-unqualified-image" },
    { storageMiB: INPUT.storageMiB + 1024 },
    { storageMiB: INPUT.storageMiB - 1024 },
  ])(
    "rejects unsupported shape/image before provider I/O: %j",
    async (override) => {
      const f = fixture();
      await expect(
        f.provider.create({
          ...INPUT,
          ...override,
        } as CloudProviderCreateInput),
      ).rejects.toMatchObject({ code: "provider_profile_unsupported" });
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.operations.prepareCreate).not.toHaveBeenCalled();
    },
  );

  it("requires a durable ownership record before reads, access or destructive I/O", async () => {
    const f = fixture();
    for (const action of [
      () => f.provider.inspect(RESOURCE),
      () => f.provider.delete(RESOURCE),
      () => f.provider.createSshAccess(RESOURCE, 5),
    ]) {
      await expect(action()).rejects.toMatchObject({
        code: "provider_identity_mismatch",
      });
    }
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.access.createSshAccess).not.toHaveBeenCalled();
  });

  it("uses the durable deletion receipt across restart even when the sandbox is no longer listed", async () => {
    const f = fixture();
    await f.allocate();
    f.fetcher
      .mockResolvedValueOnce(json(deletion()))
      .mockResolvedValueOnce(json(deletion()));
    await expect(f.provider.delete(RESOURCE)).rejects.toMatchObject({
      code: "provider_deletion_pending",
      retryable: true,
    });
    expect(f.stored().deletionOperationId).toBe(OPERATION);
    expect(f.stored().deletedAt).toBeNull();
    expect(f.access.revokeSshAccess).toHaveBeenCalledOnce();
    const restarted = new BoatWorkspaceProvider(f.options);
    f.fetcher.mockResolvedValueOnce(json(deletion("completed")));
    await expect(restarted.inspect(RESOURCE)).resolves.toBeNull();
    expect(f.fetcher.mock.calls.at(-1)![0]).toBe(
      `https://boat.dev/api/v1/deletion-operations/${OPERATION}`,
    );
    expect(f.stored().deletedAt).not.toBeNull();
    await expect(restarted.create(INPUT)).rejects.toMatchObject({
      code: "provider_generation_retired",
    });
  });

  it("never treats a 404 after a lost deletion receipt as confirmed deletion", async () => {
    const f = fixture();
    await f.allocate();
    f.fetcher.mockRejectedValueOnce(new Error("lost delete reply"));
    await expect(f.provider.delete(RESOURCE)).rejects.toMatchObject({
      retryable: true,
    });
    expect(f.stored().deletionRequestedAt).not.toBeNull();
    const restarted = new BoatWorkspaceProvider(f.options);
    f.fetcher.mockResolvedValueOnce(
      json({ ok: false, code: "not_found" }, 404),
    );
    await expect(restarted.inspect(RESOURCE)).rejects.toMatchObject({
      code: "provider_not_found",
    });
    expect(f.stored().deletedAt).toBeNull();
    expect(f.operations.completeDeletion).not.toHaveBeenCalled();
  });

  it("keeps a blocked deletion visible without aborting the managed inventory sweep", async () => {
    const f = fixture(); await f.allocate();
    await f.operations.beginDelete(RESOURCE);
    await f.operations.bindDeletion(RESOURCE, OPERATION);
    f.fetcher.mockResolvedValueOnce(json(deletion("blocked")));
    const observed = [];
    for await (const resource of f.provider.listManaged()) observed.push(resource);
    expect(observed).toMatchObject([{ resourceId: RESOURCE, state: "deleting", metadata: { deletionStatus: "blocked" } }]);
    expect(f.operations.completeDeletion).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(json(deletion("blocked")));
    await expect(f.provider.inspect(RESOURCE)).rejects.toMatchObject({ code: "provider_deletion_blocked" });
  });

  it.each([
    { targetId: "bx_abcdefgh" },
    { kind: "snapshot" },
    { id: "invalid" },
  ])("rejects mismatched deletion evidence: %j", async (override) => {
    const f = fixture();
    await f.allocate();
    f.fetcher.mockResolvedValueOnce(json(deletion("completed", override)));
    await expect(f.provider.delete(RESOURCE)).rejects.toMatchObject({
      code: "provider_response_invalid",
    });
    expect(f.stored().deletedAt).toBeNull();
  });

  it("does not stop or delete while access revocation is unconfirmed", async () => {
    const f = fixture();
    await f.allocate();
    f.access.revokeSshAccess.mockRejectedValue(new Error("revocation failed"));
    f.fetcher.mockResolvedValueOnce(json(sandbox()));
    await expect(f.provider.stop(RESOURCE)).rejects.toThrow(
      "revocation failed",
    );
    await expect(f.provider.delete(RESOURCE)).rejects.toThrow(
      "revocation failed",
    );
    expect(
      f.fetcher.mock.calls.every(
        ([, init]) =>
          !["DELETE"].includes(init?.method ?? "") &&
          !String(init?.body).includes("stop"),
      ),
    ).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(2); // create and stop's read only
  });

  it("does not silently accept a vanished allocation or borrow another sandbox", async () => {
    const f = fixture();
    await f.allocate();
    f.fetcher.mockResolvedValueOnce(json({ ok: false }, 404));
    await expect(f.provider.inspect(RESOURCE)).rejects.toMatchObject({
      code: "provider_not_found",
    });
    f.fetcher.mockResolvedValueOnce(
      json(sandbox("ready", { id: "bx_abcdefgh" })),
    );
    await expect(f.provider.inspect(RESOURCE)).rejects.toMatchObject({
      code: "provider_response_invalid",
    });
  });

  it("treats an attested lost allocation as absent without provider I/O or access", async () => {
    const f = fixture();
    await f.allocate();
    f.stored().lostAt = new Date(NOW);
    f.fetcher.mockClear();
    const restarted = new BoatWorkspaceProvider(f.options);
    await expect(restarted.inspect(RESOURCE)).resolves.toBeNull();
    await expect(restarted.find(INPUT)).resolves.toEqual([]);
    expect(await restarted.verifyAbsence(INPUT)).toBe(true);
    const observed = [];
    for await (const resource of restarted.listManaged()) observed.push(resource);
    expect(observed).toEqual([]);
    for (const action of [
      () => restarted.start(RESOURCE),
      () => restarted.startWithComputeLease(RESOURCE, 600),
      () => restarted.create(INPUT),
      () => restarted.renewComputeLease(RESOURCE, 600),
      () => restarted.readComputeUsage(RESOURCE),
      () => restarted.createSshAccess(RESOURCE, 5),
      () => restarted.getPreviewEndpoint(RESOURCE, 3000),
      () => restarted.getEngineEndpoint(RESOURCE, 7777),
    ])
      await expect(action()).rejects.toMatchObject({ code: "provider_resource_lost" });
    // Nothing remains to delete, and no deletion bookkeeping may start.
    await expect(restarted.delete(RESOURCE)).resolves.toBeUndefined();
    expect(f.operations.beginDelete).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.access.createSshAccess).not.toHaveBeenCalled();
    expect(f.access.getPreviewEndpoint).not.toHaveBeenCalled();
  });

  it("does not report durable archive success after a failed snapshot", async () => {
    const f = fixture();
    await f.allocate();
    f.fetcher.mockResolvedValueOnce(
      json(
        sandbox("archived", {
          lastSnapshotStatus: "failed",
          snapshotAvailable: true,
        }),
      ),
    );
    await expect(f.provider.inspect(RESOURCE)).resolves.toMatchObject({
      state: "failed",
    });
  });
  it("does not repeat Stop when compute stopped but its snapshot failed",async()=>{
    const f=fixture();await f.allocate();f.fetcher.mockImplementation(async()=>json(sandbox('archived',{lastSnapshotStatus:'failed'})));
    await expect(f.provider.stop(RESOURCE)).resolves.toMatchObject({state:'failed',computeStopped:true});
    expect(f.fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
  });

  it.each(['queued','in_progress'])("keeps an archived VM's %s snapshot transitional without stopping compute twice",async status=>{
    const f=fixture();await f.allocate();f.fetcher.mockImplementation(async()=>json(sandbox('archived',{lastSnapshotStatus:status})));
    await expect(f.provider.inspect(RESOURCE)).resolves.toMatchObject({state:'archiving',computeStopped:true});
    await expect(f.provider.stop(RESOURCE)).resolves.toMatchObject({state:'archiving',computeStopped:true});
    expect(f.fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
  });

  it("does not race resume against an in-progress archive", async () => {
    const f = fixture();
    await f.allocate();
    f.fetcher.mockResolvedValueOnce(json(sandbox("archiving")));
    await expect(f.provider.start(RESOURCE)).rejects.toMatchObject({
      code: "provider_operation_pending",
      retryable: true,
    });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('Boat compute metering and lease authority', () => {
  const usage = (extra: Record<string, unknown> = {}) => ({ ok: true, type: 'sandbox.usage', sandboxId: RESOURCE,
    sandboxType: 'default', billingMultiplier: 1, since: new Date(NOW - 60_000).toISOString(), until: new Date(NOW).toISOString(),
    seconds: 57, dollars: 0.00057, secondsPerDollar: 100000, running: false, ...extra });
  it('declares exact weights only for supported resource profiles', () => {
    const f=fixture();
    expect(f.provider.computeWeight({cpuMillicores:2000,memoryMiB:4096})).toEqual({numerator:1,denominator:2});
    expect(f.provider.computeWeight({cpuMillicores:4000,memoryMiB:8192})).toEqual({numerator:1,denominator:1});
    expect(f.provider.computeWeight({cpuMillicores:8000,memoryMiB:16384})).toEqual({numerator:2,denominator:1});
    expect(()=>f.provider.computeWeight({cpuMillicores:2000,memoryMiB:8192})).toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('applies the funded finite lease to the initial create and binds retries to that exact body', async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(json(sandbox('running', { archiveAfter: new Date(NOW+900_000).toISOString() })));
    await f.provider.createWithComputeLease(INPUT,900);
    expect(f.fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ type: 'default', from: 'zeros-linux-qualified', ttlSeconds: 900, noEnv: true, env: {} }) });
    await expect(f.provider.createWithComputeLease(INPUT,1800)).rejects.toThrow('conflicting body');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('applies a fresh funded lease atomically when resuming a stopped allocation', async () => {
    const f = fixture(); await f.allocate();
    f.fetcher.mockResolvedValueOnce(json(sandbox('archived', { lastSnapshotStatus: 'completed' })))
      .mockResolvedValueOnce(json({ok:true}))
      .mockResolvedValueOnce(json(sandbox('running', { archiveAfter: new Date(NOW+600_000).toISOString() })));
    expect(await f.provider.startWithComputeLease(RESOURCE,600)).toMatchObject({ state: 'running' });
    const resumed = f.fetcher.mock.calls.find(call => String(call[0]).endsWith('/resume'))!;
    expect(resumed[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ ttlSeconds: 600 }) });
  });
  it.each([0,-1,Infinity,1.5,2592001])('rejects an unfunded or unbounded initial lease: %s', async ttl => {
    const f = fixture();
    await expect(f.provider.createWithComputeLease(INPUT,ttl)).rejects.toMatchObject({ code: 'provider_lease_invalid' });
    await expect(f.provider.startWithComputeLease(RESOURCE,ttl)).rejects.toMatchObject({ code: 'provider_lease_invalid' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('reads the owned provider meter, preserving the exact window and integer cumulative price', async () => {
    const f = fixture(); await f.allocate(); f.fetcher.mockResolvedValueOnce(json(usage()));
    expect(await f.provider.readComputeUsage(RESOURCE, { since: new Date(NOW - 60_000), until: new Date(NOW) })).toEqual({
      resourceId: RESOURCE, since: new Date(NOW - 60_000).toISOString(), until: new Date(NOW).toISOString(),
      billableSeconds: 57, secondsPerDollar: 100000, listPriceMicroUsd: 570, running: false,
    });
    const url = new URL(String(f.fetcher.mock.calls.at(-1)![0]));
    expect(url.pathname).toBe(`/api/v1/sandboxes/${RESOURCE}/usage`);
    expect(url.searchParams.get('since')).toBe(new Date(NOW - 60_000).toISOString());
  });
  it.each([
    { sandboxId: 'bx_abcdefgh' }, { seconds: -1 }, { seconds: 1.5 }, { seconds: 121 },
    { secondsPerDollar: 0 }, { billingMultiplier: 2 }, { until: new Date(NOW + 60000).toISOString() },
    { since: new Date(NOW - 120000).toISOString() },
  ])('rejects an inconsistent meter without trusting the reported dollars: %j', async extra => {
    const f = fixture(); await f.allocate(); f.fetcher.mockResolvedValueOnce(json(usage(extra)));
    await expect(f.provider.readComputeUsage(RESOURCE, { since: new Date(NOW - 60000) })).rejects.toMatchObject({ code: 'provider_usage_invalid' });
  });
  it('prices already-weighted large-machine seconds once', async () => {
    const f = fixture(); await f.allocate(); f.fetcher.mockResolvedValueOnce(json(usage({ sandboxType: 'large', billingMultiplier: 2, seconds: 120, dollars: 1000 })));
    expect(await f.provider.readComputeUsage(RESOURCE)).toMatchObject({ billableSeconds: 120, listPriceMicroUsd: 1200 });
  });
  it('does not treat the current machine size as proof of its historical billing rate', async () => {
    const f = fixture(); await f.allocate();
    f.fetcher.mockResolvedValueOnce(json(usage({ sandboxType: 'small', billingMultiplier: 0.5, seconds: 100 })));
    expect(await f.provider.readComputeUsage(RESOURCE)).toMatchObject({ billableSeconds: 100, listPriceMicroUsd: 1000 });
  });
  it('refuses an unowned resource and invalid windows before network access', async () => {
    const f = fixture();
    await expect(f.provider.readComputeUsage(RESOURCE)).rejects.toMatchObject({ code: 'provider_identity_mismatch' });
    await expect(f.provider.readComputeUsage(RESOURCE, { since: new Date('invalid') })).rejects.toMatchObject({ code: 'provider_usage_invalid' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('renews an exact owned resource with a finite auto-stop deadline', async () => {
    const f = fixture(); await f.allocate();
    const expiresAt = new Date(NOW + 3600_000).toISOString();
    f.fetcher.mockResolvedValueOnce(json(sandbox('running', { archiveAfter: expiresAt })));
    expect(await f.provider.renewComputeLease(RESOURCE, 3600)).toEqual({ expiresAt });
    expect(f.fetcher.mock.calls.at(-1)![1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ ttlSeconds: 3600 }) });
  });
  it.each([0, -1, Infinity, 1.5, 2592001])('rejects an unsafe renewal horizon: %s', async ttl => {
    const f = fixture(); await expect(f.provider.renewComputeLease(RESOURCE, ttl)).rejects.toMatchObject({ code: 'provider_lease_invalid' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([null, new Date(NOW - 1).toISOString(), new Date(NOW + 3700_000).toISOString()])('does not confirm a missing or excessive deadline: %s', async archiveAfter => {
    const f = fixture(); await f.allocate(); f.fetcher.mockResolvedValueOnce(json(sandbox('running', { archiveAfter })));
    await expect(f.provider.renewComputeLease(RESOURCE, 3600)).rejects.toMatchObject({ code: 'provider_lease_unconfirmed' });
  });
  it('refuses lease renewal after deletion has been accepted', async () => {
    const f = fixture(); await f.allocate(); await f.operations.beginDelete(RESOURCE);
    f.fetcher.mockClear(); await expect(f.provider.renewComputeLease(RESOURCE, 3600)).rejects.toMatchObject({ code: 'provider_generation_retired' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
