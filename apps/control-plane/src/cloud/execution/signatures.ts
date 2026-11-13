import { createHash } from "node:crypto";
import { z } from "zod";
import { CloudSourceTargetSchema } from "../source-authority.js";

const basisSchema = z.object({
  permission: z.tuple([z.string(), z.string(), z.string(), z.string().nullable(), z.string(), z.string(),
    z.string(), z.string(), z.string(), z.string(), z.array(CloudSourceTargetSchema).max(100), z.unknown()]),
  policy: z.tuple([z.boolean(), z.boolean(), z.boolean()]),
  accessEpoch: z.string(), stopGeneration: z.string(), bootId: z.string().nullable(), workerTokenHash: z.string().nullable(),
});
export type ExecutionSignatureBasis = z.infer<typeof basisSchema>;
export type VersionedExecutionAuthority = { signatureVersion?: number; legacyBasis?: unknown };
type SignatureKind = "permissionSignature" | "personSignature" | "signature";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function signatures(permission: unknown[], basis: ExecutionSignatureBasis) {
  const permissionSignature = hash(permission);
  const personSignature = hash([permissionSignature, basis.accessEpoch, basis.stopGeneration]);
  return { permissionSignature, personSignature, signature: hash([personSignature, basis.bootId, basis.workerTokenHash]) };
}

function personPermission(basis: ExecutionSignatureBasis, version: 2 | 3) {
  const [workspace, organization, user, , account, member, incarnation, , role, repository, targets, connection] = basis.permission;
  return [version, workspace, organization, user, account, member, incarnation, role, repository, targets,
    ...(version === 2 ? [connection] : []), basis.policy];
}

export function executionSignatures(basis: ExecutionSignatureBasis) {
  return { ...signatures(personPermission(basis, 3), basis), legacyBasis: basis, signatureVersion: 3 as const };
}
export type ExecutionSignatures = ReturnType<typeof executionSignatures>;

export function matchesExecutionSignature(authority: VersionedExecutionAuthority, signature: string,
  person: ExecutionSignatures, kind: SignatureKind): boolean {
  if (authority.signatureVersion === 3) return signature === person[kind];
  if (authority.signatureVersion !== undefined && authority.signatureVersion !== 1 && authority.signatureVersion !== 2) return false;
  const basis = authority.legacyBasis ?? person.legacyBasis;
  if (Buffer.byteLength(JSON.stringify(basis)) > 65536) return false;
  const parsed = basisSchema.safeParse(basis);
  if (!parsed.success) return false;
  // The migration captures the old hash's inputs, not a fresh authorization.
  // Verify that original hash before comparing the same person's current scope.
  return signatures(authority.signatureVersion === 2 ? personPermission(parsed.data, 2) : parsed.data.permission, parsed.data)[kind] === signature &&
    executionSignatures(parsed.data)[kind] === person[kind];
}

export const executionContextAuthority = (person: ExecutionSignatures) => ({ signatureVersion: person.signatureVersion, signature: person.signature });
