import { beforeEach, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ load: vi.fn(), custody: vi.fn(), registry: vi.fn(), boundary: vi.fn(), live: vi.fn(), inspect: vi.fn(), dispose: vi.fn() }));
vi.mock("../../apps/desktop/src/engine/pty/pty-host-client", () => ({ disposePtyHost: ports.dispose }));
vi.mock("../../apps/desktop/src/engine/agents/containment/cloud-worker-config", () => ({ loadCloudWorkerConfiguration: ports.load }));
vi.mock("../../apps/desktop/src/engine/agents/containment/cloud-workload-custody", () => ({ createCloudWorkloadCustody: ports.custody }));
vi.mock("../../apps/desktop/src/engine/agents/containment/cloud-owned-workloads", () => ({ CloudOwnedWorkloadRegistry: class { inspect = ports.inspect; constructor(options: unknown) { ports.registry(options); } } }));
vi.mock("../../apps/desktop/src/engine/agents/containment/cloud-execution-boundary", () => ({ CloudExecutionBoundary: class { constructor(options: unknown) { ports.boundary(options); } } }));
import { createCloudQualificationRuntime, inspectCloudQualificationWorkloads } from "../cloud-workspace-validation/sandbox/cloud-qualification-runtime";
const configuration = { uid: 10003, gid: 10003 };
const custody = { assertLive: ports.live };
beforeEach(() => { for (const fn of Object.values(ports)) fn.mockReset(); ports.load.mockReturnValue(configuration); ports.custody.mockReturnValue(custody); });
it("shares one original controller custody, registry and boundary across inline role probes", () => {
  const context = createCloudQualificationRuntime();
  expect(context.configuration).toBe(configuration); expect(context.custody).toBe(custody);
  expect(ports.custody).toHaveBeenCalledExactlyOnceWith(configuration);
  expect(ports.registry).toHaveBeenCalledExactlyOnceWith({ custody });
  expect(ports.boundary).toHaveBeenCalledExactlyOnceWith({ projectRoot: "/srv/zeros/workspace", configuration, workloads: context.workloads });
  expect(ports.live).toHaveBeenCalledOnce();
  expect(ports.dispose).not.toHaveBeenCalled();
});
it("ends the engine's process-global PTY transport with the controller", () => {
  const context = createCloudQualificationRuntime();
  context.close(); expect(ports.dispose).toHaveBeenCalledOnce();
});
it.each([null, { uid: 0, gid: 0 }, { uid: 10001, gid: 10001 }])("refuses absent or legacy activation identity %s", value => {
  ports.load.mockReturnValue(value); expect(() => createCloudQualificationRuntime()).toThrow();
  expect(ports.registry).not.toHaveBeenCalled(); expect(ports.boundary).not.toHaveBeenCalled();
});
it("does not create a registry when actual controller custody cannot be confirmed", () => {
  ports.live.mockImplementation(() => { throw new Error("fixture rejected"); });
  expect(() => createCloudQualificationRuntime()).toThrow(); expect(ports.registry).not.toHaveBeenCalled();
});
it("does not treat the engine controller as a live capture or drop pending original launches", async () => {
  const context = createCloudQualificationRuntime();
  ports.inspect.mockResolvedValue({ complete: true, pendingLaunches: 1, failedRetirements: 0, workloadPids: [33], infrastructurePids: [22] });
  await expect(inspectCloudQualificationWorkloads(context)).resolves.toEqual({ pendingLaunches: 1, workloadPids: [33] });
});
it.each([{ complete: false }, { failedRetirements: 1 }])("refuses incomplete original workload observation %j", change => {
  const context = createCloudQualificationRuntime();
  ports.inspect.mockResolvedValue({ complete: true, pendingLaunches: 0, failedRetirements: 0, workloadPids: [], infrastructurePids: [22], ...change });
  return expect(inspectCloudQualificationWorkloads(context)).rejects.toThrow();
});
