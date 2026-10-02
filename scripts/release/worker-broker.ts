import { z } from "zod";
import { PromotionError, requireCheck, type PromotionConfig } from "./contracts";
import { ReleaseCanaryBindingsSchema, ReleaseCanaryAdmissionSchema, ReleaseCanaryRetirementSchema, RELEASE_CANARY_MODELS,
  RELEASE_CANARY_UPLOAD_FORBIDDEN, type ReleaseCanaryConnection } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";
import type { WorkerQualificationProfile } from "./worker-profile";

export type { ReleaseCanaryConnection };
export const WORKER_CANARY_SECRET_NAMES = ["WORKER_CANARY_ADMISSION_TOKEN"] as const;
export class ReleaseCanaryPrelaunchError extends PromotionError {
  readonly failure = { version: 1 as const, stage: "private-input-upload" as const, classification: "forbidden" as const, status: 403 as const };
  constructor() { super(RELEASE_CANARY_UPLOAD_FORBIDDEN); }
}
export function releaseCanaryConnections(value: unknown, profile: WorkerQualificationProfile) {
  const parsed = ReleaseCanaryBindingsSchema.safeParse(value);
  requireCheck(parsed.success, "Release discovery requires exactly the three distinct owner-designated kinds");
  for (const row of parsed.data) {
    requireCheck(profile !== "smoke" || row.model === RELEASE_CANARY_MODELS[row.kind], "Smoke canaries require the pinned low-cost models");
  }
  return new Map(parsed.data.map(row => [row.kind, row]));
}
export function releaseCanaryBroker(config: PromotionConfig, env: NodeJS.ProcessEnv, profile: WorkerQualificationProfile, fetcher = fetch) {
  requireCheck((env.WORKER_CANARY_ADMISSION_TOKEN?.length ?? 0) >= 32 && z.string().uuid().safeParse(env.WORKER_CANARY_ORGANIZATION_ID).success &&
    z.string().uuid().safeParse(env.RUNTIME_QUALIFICATION_ACTOR_USER_ID).success, "Protected release-only canary admission authority is missing");
  let connections: Map<string, ReleaseCanaryConnection> | undefined;
  const scope = { version: 1, channel: config.channel, ownerUserId: env.RUNTIME_QUALIFICATION_ACTOR_USER_ID, organizationId: env.WORKER_CANARY_ORGANIZATION_ID,
    sourceSha: config.sourceSha, repository: config.repository, qualificationProfile: profile, runId: config.runId, runAttempt: config.runAttempt, branch: config.branch };
  const request = async (route: string, body: unknown, signal?: AbortSignal) => {
    try {
      const result = await fetcher(`${config.api}/internal/v1/release-canaries/${route}`, { method: "POST", redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
        headers: { authorization: `Bearer ${env.WORKER_CANARY_ADMISSION_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const bytes = await result.text(); requireCheck(bytes.length <= 8192, "Release canary response exceeds its bound");
      const value = JSON.parse(bytes);
      if (!result.ok) {
        if (route === "admissions" && result.status === 409 && value?.error?.code === "release_canary_prelaunch_forbidden") throw new ReleaseCanaryPrelaunchError();
        const message = value?.error?.message;
        if (value?.error?.code === "release_canary_unavailable" && typeof message === "string" &&
          /^Release canary (?:designation (?:missing|ambiguous)|model not approved) for (?:claude-setup-token|codex-chatgpt|cursor-api-key)$/.test(message))
          throw new PromotionError(message);
        throw new Error();
      }
      return value;
    } catch (error) {
      if (error instanceof PromotionError) throw error;
      throw new PromotionError("Release canary admission is unconfirmed; reconcile the channel audit and disposable VM before retrying");
    }
  };
  return {
    async preflight() {
      const result = await request("preflight", scope);
      requireCheck(result.ready === true && Object.keys(result).length === Object.keys(scope).length + 2 &&
        Object.entries(scope).every(([key, value]) => result[key] === value), "Release canary owner designations are not ready for this exact API and run");
      const discovered = releaseCanaryConnections(result.connections, profile);
      requireCheck(!connections || JSON.stringify([...connections.values()]) === JSON.stringify([...discovered.values()]), "Release canary designations changed during this run; reconcile before retrying");
      connections = discovered; return discovered;
    },
    async start(target: unknown, kind: string, retain?: (intent: unknown) => Promise<void>) {
      const selected = connections?.get(kind); requireCheck(selected, "Release canary discovery is required before dispatching this kind");
      const intent = ReleaseCanaryAdmissionSchema.safeParse({ ...scope, ...selected, operationId: (target as any).attempt, target });
      requireCheck(intent.success, "Release canary dispatch intent is invalid");
      await retain?.(intent.data);
      const result = await request("admissions", intent.data);
      requireCheck(result.started === true && Object.keys(result).length === 1, "Release canary admission returned an unexpected public result");
    },
    async retire(operationId: string, deletionOperationId: string, leaseToken: string, signal?: AbortSignal) {
      const input = ReleaseCanaryRetirementSchema.safeParse({ version: 1, operationId, deletionOperationId, leaseToken });
      requireCheck(input.success, "Release canary retirement identity is invalid");
      const result = await request("retirements", input.data, signal);
      requireCheck(result.retired === true && Object.keys(result).length === 1, "Release canary terminal reconciliation is unconfirmed");
    },
  };
}
