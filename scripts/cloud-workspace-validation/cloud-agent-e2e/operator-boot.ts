import type { CloudAgentBootScope } from "@zeros/protocol/cloud-agent-bootstrap";
import type { FixtureControlPlane } from "./fixture-control-plane/server";
import { HarnessFailure } from "./assertions";
import { requireBootMeasurementBinding } from "./boot-measurement";

type Mode = "none" | "current" | "boot-owner";
type Fixture = { actor: { userId: string }; configureBootOwner: FixtureControlPlane["configureBootOwner"];
  activeBootScope(): CloudAgentBootScope; inspect(): { boot?: { negotiated: boolean; activated: boolean } } };

/** Explicit synthetic owner configuration before registration. This neither
 * imports ambient credentials nor substitutes for real engine activation. */
export function configureFixtureMeasurement(fixture: Pick<Fixture, "actor" | "configureBootOwner">, mode: Mode) {
  if (mode === "boot-owner") fixture.configureBootOwner({ fundingOwnerUserId: fixture.actor.userId,
    fundingOwnerEpoch: 1, actorFundingGrant: { kind: "owner" } });
}

export function createMeasurementReadyGate(fixture: Pick<Fixture, "activeBootScope" | "inspect">, mode: Mode) {
  let observed: { type: "ENGINE_READY"; source: "engine"; capabilities: string[];
    cloudLocalCommands: ReturnType<typeof requireBootMeasurementBinding> } | undefined;
  const verifyBinding = (message: unknown) => {
    const boot = fixture.inspect().boot;
    return requireBootMeasurementBinding(message, { negotiated: boot?.negotiated === true, activated: boot?.activated === true,
      scope: fixture.activeBootScope(), authorityEpoch: 1 });
  };
  return {
    verify(message: unknown): boolean {
      if (mode !== "boot-owner") return true;
      observed = undefined;
      try {
        const cloudLocalCommands = verifyBinding(message), row = message as { capabilities: unknown[] };
        observed = { type: "ENGINE_READY", source: "engine", cloudLocalCommands,
          capabilities: row.capabilities.filter((value): value is string => value === "cloud.localCommands.v1" || value === "cloud.turnTimings.v1") };
        return true;
      } catch { return false; }
    },
    ready() {
      if (mode !== "boot-owner" || !observed) throw new HarnessFailure("fixture_contract_invalid");
      try { verifyBinding(observed); } catch { observed = undefined; throw new HarnessFailure("fixture_contract_invalid"); }
      return structuredClone(observed);
    },
  };
}
