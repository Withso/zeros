import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSdkStreamEvent, CloudSdkStreamSnapshot } from "../../../../shared/cloud-sdk-stream-contract";
const state = vi.hoisted(() => ({ epoch: 1, invoke: vi.fn(), listen: vi.fn() }));
vi.mock("../runtime", () => ({ nativeInvoke: state.invoke, nativeListen: state.listen }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.epoch }));
import { controlCloudSdkStream, listenCloudSdkStream, subscribeCloudSdkRuntimeRenewals } from "../cloud-sdk-stream";

const id = (n: number) => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const target = { organizationId: id(1), workspaceId: id(2) };
const runtime = { ...target, runtimeId: id(3), generation: 7, authorityEpoch: 2, connectionSequence: 1, engineInstanceId: id(4) };
const snapshot: CloudSdkStreamSnapshot = { streamId: id(5), leaseId: id(6), sequence: 0, revision: 1, state: "open", catalogRequired: true, organizations: [] };
const capabilities = { engine: { token: "native-engine-grant", expiresAt: "2027-01-15T08:05:00.000Z" },
  realtime: { token: "native-relay-grant", expiresAt: "2027-01-15T08:05:00.000Z" } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => { vi.clearAllMocks(); state.epoch = 1; state.invoke.mockResolvedValue(snapshot); state.listen.mockResolvedValue(vi.fn()); });

describe("renderer native device stream boundary", () => {
  it("uses only the closed native control and rejects renderer-supplied stream URLs", async () => {
    expect(await controlCloudSdkStream({ action: "start", target })).toEqual(snapshot);
    expect(state.invoke).toHaveBeenCalledExactlyOnceWith("cloud_workspace_sdk_stream", { action: "start", target });
    await expect(controlCloudSdkStream({ action: "start", target, url: "wss://untrusted.example.test" } as never)).rejects.toThrow();
    expect(state.invoke).toHaveBeenCalledOnce();
  });

  it("stops a start result that arrives after an account incarnation change", async () => {
    const pending = deferred<unknown>(); state.invoke.mockReturnValueOnce(pending.promise).mockResolvedValue(true);
    const start = controlCloudSdkStream({ action: "start", target });
    const rejected = expect(start).rejects.toMatchObject({ code: "cloud_workspace_access_superseded" });
    state.epoch += 2; pending.resolve(snapshot); await rejected;
    expect(state.invoke).toHaveBeenLastCalledWith("cloud_workspace_sdk_stream", { action: "stop", streamId: id(5), leaseId: id(6) });
  });

  it("fences native events by the subscribing account incarnation", async () => {
    const received = vi.fn(); await listenCloudSdkStream(received);
    const event = state.listen.mock.calls[0]![1] as (event: unknown) => void;
    event({ ...snapshot, event: { type: "state" } }); expect(received).toHaveBeenCalledOnce();
    state.epoch += 2; event({ ...snapshot, event: { type: "state" } }); expect(received).toHaveBeenCalledOnce();
  });

  it("delivers pushed capabilities only for the exact native runtime and new event sequence", async () => {
    const received = vi.fn(), descriptor = { ...runtime, connect: { capabilities }, deviceSessionId: id(7), clientSessionId: id(8) };
    await subscribeCloudSdkRuntimeRenewals(descriptor, received);
    const send = state.listen.mock.calls[0]![1] as (event: unknown) => void;
    const event: CloudSdkStreamEvent = { ...snapshot, sequence: 1, event: { type: "renewal", runtime, capabilities } };
    send({ ...event, event: { ...event.event, runtime: { ...runtime, connectionSequence: 2 } } });
    send({ ...event, event: { ...event.event, runtime: { ...runtime, organizationId: id(9) } } });
    expect(received).not.toHaveBeenCalled();
    send(event); send(event); expect(received).toHaveBeenCalledExactlyOnceWith(capabilities);
    state.epoch++; send({ ...event, sequence: 2 }); expect(received).toHaveBeenCalledOnce();
  });
});
