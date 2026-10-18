import { randomBytes, randomUUID, sign } from "node:crypto";
import { vi } from "vitest";
import { CloudAcceptedWorkReceiptSchema } from "@zeros/protocol/cloud-accepted-work";
import type { CloudBootCommandMutation } from "@zeros/protocol/cloud-commands";
import { cloudAcceptedWorkCommandBinding, cloudAcceptedWorkProofMessage } from "@zeros/protocol/cloud-accepted-work-client";
import { EngineCapabilityAuth } from "../../../cloud-capability-auth";
import type { CloudLocalAgentBootRuntime } from "../../../cloud-local-command-queue-boot";
import type { testCloudBootFixture } from "./test-cloud-boot";
import { TEST_CAPABILITY_HEADER, testClientClaims, signTestCapability, signTestProof, testSigningJwk,
  testEd25519Key } from "../../../../../../control-plane/src/cloud-workspaces/capability-verifier-test-utils";

export async function testAcceptedWorkOptions(f: Awaited<ReturnType<typeof testCloudBootFixture>>) {
  const scope = f.scope, actor = f.provenance.actor;
  const auth = new EngineCapabilityAuth({ identity: scope, issuer: "https://cp.example.test",
    store: { read: async () => null, write: async () => {} } });
  await auth.applyKeys([{ ...testSigningJwk(TEST_CAPABILITY_HEADER.kid), use: "sig", alg: "EdDSA" }]);
  await auth.applySync({ syncId: randomUUID(), complete: true, authCursor: "accepted-boot", epochs: { wa: 1, wr: 1 }, revocations: [] });
  const claims = testClientClaims({ sub: `user:${actor.userId}`, did: actor.deviceId, org: scope.organizationId,
    wsp: scope.workspaceId, gen: scope.generation, ein: scope.engineInstanceId, role: "owner",
    ep: { wa: 1, wr: 1, me: 1, ac: 1, dk: actor.deviceKeyVersion },
    iat: Math.floor(Date.now() / 1000), nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 });
  const capability = signTestCapability(TEST_CAPABILITY_HEADER, claims), clientSessionId = randomUUID();
  const proof = () => {
    const fields = { aud: "zeros:engine", wsp: scope.workspaceId, jti: String(claims.jti), timestampMs: Date.now(),
      nonce: randomBytes(16).toString("base64url"), route: "direct" as const };
    return { timestampMs: fields.timestampMs, nonce: fields.nonce, signature: signTestProof("device-a", fields) };
  };
  const verified = await auth.verifyClient({ capability, proof: proof() }, "direct");
  if (!verified.ok) throw new Error(`fixture capability: ${verified.code}`);
  auth.admit(clientSessionId, verified, "direct");
  const runtimeId = `r1-${"a".repeat(64)}`, closed = vi.fn(async () => ({ closed: true as const }));
  const context = await f.contextRequest({ ...scope, version: 1, mode: "boot-owner-v1",
    actorSessionId: f.provenance.actorSessionId, ...f.input, repositoryServers: [] });
  const { actor: _legacy, ...material } = context;
  const warm = vi.fn(async (input: import("@zeros/protocol/cloud-accepted-work").CloudAcceptedWorkContextRequest) => ({
    ...material, acceptedWork: { acceptedWorkId: input.acceptedWorkId, confirmedUntilMs: Date.now() + 8_000 } }));
  let healthy = true;
  const listeners = new Set<() => void>();
  const options: NonNullable<ConstructorParameters<typeof CloudLocalAgentBootRuntime>[0]["accepted"]> = { auth: () => auth, runtimeId, enabled: () => true,
    health: { retain: () => () => {}, deadline: () => healthy ? performance.now() + 10_000 : null,
      onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    enroll: async request => CloudAcceptedWorkReceiptSchema.parse({ version: 1, acceptedWorkId: randomUUID(), revision: 1,
      scope, runtimeId, actorSessionId: f.provenance.actorSessionId, actor, sourceSessionId: claims.sid,
      kid: TEST_CAPABILITY_HEADER.kid, capabilityId: claims.jti, devicePublicKey: verified.claims.cnf!.jwk.x,
      epochs: verified.claims.ep, scopes: verified.claims.scp, command: request.command, acceptedAtMs: Date.now(),
      capabilityExpiresAtMs: Number(claims.exp) * 1000, providerExpiresAtMs: Date.now() + 3_600_000, providerProofVersion: 1 }),
    context: warm, close: closed };
  const senderProof = (request: { mutation: CloudBootCommandMutation }) => {
    const fresh = proof();
    return { version: 1 as const, capability, proof: fresh, commandSignature: sign(null, Buffer.from(cloudAcceptedWorkProofMessage({
      aud: "zeros:engine", wsp: scope.workspaceId, jti: String(claims.jti), scope, ...cloudAcceptedWorkCommandBinding(request.mutation),
      timestampMs: fresh.timestampMs, nonce: fresh.nonce, route: "direct" })), testEd25519Key("device-a").privateKey).toString("base64url") };
  };
  return { options, auth, clientSessionId, senderProof, warm, closed, close: () => auth.stop(),
    losePush: () => { healthy = false; for (const listener of listeners) listener(); } };
}
