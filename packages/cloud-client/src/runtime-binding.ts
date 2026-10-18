import type { CloudAgentBootScope, ConnectResponse, RuntimeBinding } from "./generated/rest";

export type RuntimeBindingTarget = Readonly<{ organizationId: string; workspaceId: string; generation?: number }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FIELDS = ["organizationId", "workspaceId", "engineInstanceId", "bootId", "writerEpoch", "fundingOwnerUserId"] as const;
const REVISION_FIELDS = ["generation", "fundingOwnerEpoch"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Nonsecret admission metadata, never authority inferred from decoded JWTs.
 * Absence identifies an older server; malformed or cross-target metadata must
 * fail before a socket or native runtime handle is created. */
export function readRuntimeBinding(connect: ConnectResponse, target?: RuntimeBindingTarget): RuntimeBinding | null {
  const binding: unknown = connect.runtimeBinding;
  if (binding === undefined) return null;
  const invalid = () => new TypeError("runtime_binding_invalid");
  if (!isRecord(binding) || !isRevision(binding.authorityEpoch) || !isRecord(binding.bootScope)) throw invalid();
  if (binding.acceptedWorkVersion !== undefined && binding.acceptedWorkVersion !== 1) throw invalid();
  const scope = binding.bootScope;
  if (Object.keys(scope).length !== UUID_FIELDS.length + REVISION_FIELDS.length ||
      UUID_FIELDS.some(key => typeof scope[key] !== "string" || !UUID.test(scope[key])) ||
      REVISION_FIELDS.some(key => !isRevision(scope[key])) ||
      scope.workspaceId !== connect.workspaceId || scope.generation !== connect.generation ||
      scope.engineInstanceId !== connect.engineInstanceId ||
      (target && (scope.organizationId !== target.organizationId || scope.workspaceId !== target.workspaceId ||
        (target.generation !== undefined && scope.generation !== target.generation)))) throw invalid();
  return Object.freeze({ authorityEpoch: binding.authorityEpoch,
    bootScope: Object.freeze({ ...scope }) as CloudAgentBootScope,
    ...(binding.acceptedWorkVersion === 1 ? { acceptedWorkVersion: 1 as const } : {}) });
}
