import { performance } from "node:perf_hooks";
import type { FixtureControlPlane, MeasurementCheckpoint } from "./fixture-control-plane/server";
import { HarnessFailure } from "./assertions";
import { createRendererGrant } from "./renderer-grant";
import { driveRendererTurn } from "./renderer-turn";
import { summarizeFixtureIngress, summarizeFixtureWindow } from "./ingress";
import { requireBootMeasurementBinding } from "./boot-measurement";
import { awaitFixtureMirrorFinal } from "./mirror-final";

type TurnInput = Parameters<typeof driveRendererTurn>[1];
type CounterFixture = Pick<FixtureControlPlane, "identity" | "measurementCheckpoint" | "measurementWindow">;
type Fixture = Pick<FixtureControlPlane, "identity" | "rendererAuthority" | "measurementCheckpoint" |
  "measurementWindow" | "assertTerminalConsistency" | "readEvents">;
type CommonInput = Omit<TurnInput, "scope" | "grant" | "onSend" | "onRendererSettled" | "verifyTerminal" | "fixtureEvents" | "mode" | "bootBinding">;
type Input = CommonInput & { mode?: TurnInput["mode"];
  fixture: Fixture; baseUrl: string; ca: Buffer;
};
type BootFixture = CounterFixture & Pick<FixtureControlPlane, "activeBootScope"> & Parameters<typeof awaitFixtureMirrorFinal>[0]["fixture"] & {
  inspect(): { boot?: { negotiated: boolean; activated: boolean } };
};
type BootInput = CommonInput & { fixture: BootFixture; engineReady: unknown;
  localProof: Parameters<typeof awaitFixtureMirrorFinal>[0]["localProof"] };

/** CURRENT/legacy measurement over the real renderer Send. Only the actual
 * fixture producer supplies HTTP arrival evidence. Production SQL and CP
 * relay paths are not exercised by this direct, in-memory fixture topology.
 * The wider observation window covers calibration uncertainty and is never
 * substituted for exact Send/result counts or foreground causality. */
export async function measureCurrentTurn(bridge: Parameters<typeof driveRendererTurn>[0], input: Input) {
  if (input.mode && input.mode !== "legacy") throw new HarnessFailure("fixture_contract_invalid");
  const { fixture, baseUrl, ca, ...turnInput } = input;
  const authority = fixture.rendererAuthority();
  const grant = createRendererGrant({ baseUrl, ca, workspaceId: fixture.identity.workspaceId,
    actorUserId: authority.userId, bearerToken: authority.bearerToken });
  return measureTurn(bridge, turnInput, fixture, { mode: "legacy", grant,
    verifyTerminal: commandId => fixture.assertTerminalConsistency(commandId), fixtureEvents: () => fixture.readEvents() });
}

/** Explicit negotiated after path. VM replay stays authoritative; the compact
 * CP final is independently compared AFTER the renderer result window. */
export async function measureBootOwnerTurn(bridge: Parameters<typeof driveRendererTurn>[0], input: BootInput) {
  const { fixture, engineReady, localProof, ...turnInput } = input;
  const status = fixture.inspect().boot;
  const boot = requireBootMeasurementBinding(engineReady, { negotiated: status?.negotiated === true,
    activated: status?.activated === true, scope: fixture.activeBootScope(), authorityEpoch: 1 });
  let compactFinal: Awaited<ReturnType<typeof awaitFixtureMirrorFinal>> | undefined;
  const measured = await measureTurn(bridge, turnInput, fixture, { mode: "boot-owner-v1", bootBinding: boot,
    grant: async () => { throw new HarnessFailure("fixture_contract_invalid"); },
    verifyTerminal: async (commandId, observed, signal) => {
      if (!observed || !signal || observed.conversationId !== turnInput.conversationId) throw new HarnessFailure("receipt_mismatch");
      const { conversationId: _conversation, ...entry } = observed;
      compactFinal = await awaitFixtureMirrorFinal({ scope: fixture.activeBootScope(), conversationId: turnInput.conversationId,
        commandId, entry, fixture, localProof, signal });
    } });
  if (!compactFinal) throw new HarnessFailure("fixture_inspection_failed");
  return { ...measured, compactFinal };
}

async function measureTurn(bridge: Parameters<typeof driveRendererTurn>[0], turnInput: CommonInput,
  fixture: CounterFixture, ports: Pick<TurnInput, "grant" | "verifyTerminal" | "fixtureEvents" | "bootBinding"> & { mode: "legacy" | "boot-owner-v1" }) {
  const clientBeforeAtMs = performance.now();
  const observationStart = fixture.measurementCheckpoint();
  const clientAfterAtMs = performance.now();
  let sendStart: MeasurementCheckpoint | undefined, sendEnd: MeasurementCheckpoint | undefined;
  const { organizationId, workspaceId, generation, engineInstanceId } = fixture.identity;
  const turn = await driveRendererTurn(bridge, { ...turnInput, ...ports, scope: { organizationId, workspaceId, generation, engineInstanceId },
    onSend: () => { sendStart = fixture.measurementCheckpoint(); },
    onRendererSettled: () => { sendEnd = fixture.measurementCheckpoint(); },
  });
  if (!sendStart || !sendEnd) throw new HarnessFailure("fixture_measurement_invalid");
  const observationEnd = fixture.measurementCheckpoint();
  const sendWindow = summarizeFixtureWindow(fixture.measurementWindow(sendStart, sendEnd));
  const observationWindow = fixture.measurementWindow(observationStart, observationEnd);
  const clock = { clockDomainId: observationStart.clockDomainId, clientClockId: turn.clientTiming.clockId,
    clientBeforeAtMs, fixtureSampleAtUs: observationStart.atUs, clientAfterAtMs };
  const absolute = (range: { min: number; max: number }) => ({ min: turn.clientTiming.sentAtMs + range.min,
    max: turn.clientTiming.sentAtMs + range.max });
  const from = turn.timing.sendToEngineMs;
  if (!from) throw new HarnessFailure("timing_stage_missing");
  const endpoints = { native_write: turn.timing.sendToNativeWriteMs, native_acceptance_ack: turn.timing.sendToNativeAcceptanceMs,
    sdk_run_created: turn.timing.sendToSdkRunCreatedMs, typed_auth_failure: turn.timing.sendToTypedAuthFailureMs };
  const interval = (stage: keyof typeof endpoints, fromAtMs = absolute(from)) => {
    const endpoint = endpoints[stage];
    return endpoint ? summarizeFixtureIngress(observationWindow, clock, { clientClockId: turn.clientTiming.clockId,
      throughStage: stage, fromAtMs, throughAtMs: absolute(endpoint) }) : null;
  };
  const observedIntervals = { native_write: interval("native_write"), native_acceptance_ack: interval("native_acceptance_ack"),
    sdk_run_created: interval("sdk_run_created"), typed_auth_failure: interval("typed_auth_failure") };
  const ingress = observedIntervals.native_acceptance_ack ?? observedIntervals.sdk_run_created ?? observedIntervals.native_write ?? observedIntervals.typed_auth_failure;
  if (!ingress) throw new HarnessFailure("timing_stage_missing");
  // Keep the original engine-received intervals. This distinct Send boundary
  // also includes renderer-side preparation before the engine receives Send.
  const sendToNativeWriteIngress = interval("native_write", { min: turn.clientTiming.sentAtMs, max: turn.clientTiming.sentAtMs });
  return { version: 1 as const, mode: ports.mode, turn, sendWindow, ingress, observedIntervals,
    sendToNativeWriteIngress,
    observationWindowIncludesSetupAndVerification: true as const,
    causalCoverage: "unavailable" as const, foregroundCpRequests: null, backgroundCpRequests: null,
    productionSql: { exercised: false as const, writeStatements: null, rows: null, encodedBytes: null, transactions: null },
    controlPlaneRelay: { exercised: false as const, clientToEngineBytes: null, engineToClientBytes: null, subscribers: null } };
}
