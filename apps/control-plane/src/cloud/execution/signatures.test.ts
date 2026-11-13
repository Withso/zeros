import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executionSignatures, matchesExecutionSignature, type ExecutionSignatureBasis } from "./signatures.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const basis = (): ExecutionSignatureBasis => ({
  permission: ["workspace", "organization", "person", "creator", "1", "2", "membership-incarnation", "3", "member", "example/project",
    [{ repository: "example/project", repositoryId: "42" }], [["pat", "selection"], [["credential", "pat", "generation", "12"]]]],
  policy: [false, true, true], accessEpoch: "4", stopGeneration: "5", bootId: "boot", workerTokenHash: "worker",
});
function previous(value: ExecutionSignatureBasis, version: 1 | 2) {
  const [workspace, org, user, , account, member, incarnation, , role, repository, targets, connection] = value.permission;
  const permissionSignature = hash(version === 1 ? value.permission : [2, workspace, org, user, account, member, incarnation, role, repository, targets, connection, value.policy]);
  const personSignature = hash([permissionSignature, value.accessEpoch, value.stopGeneration]);
  return { permissionSignature, personSignature, signature: hash([personSignature, value.bootId, value.workerTokenHash]) };
}

describe("membership execution signatures", () => {
  it.each([1, 2] as const)("accepts an authentic v%s authority after GitHub changes, without carrying its network grant forward", version => {
    const original = basis(), changed = basis(); changed.permission[11] = null;
    const old = previous(original, version), current = executionSignatures(changed);
    expect(current.signatureVersion).toBe(3);
    for (const kind of ["permissionSignature", "personSignature", "signature"] as const) {
      expect(matchesExecutionSignature({ signatureVersion: version, legacyBasis: original }, old[kind], current, kind)).toBe(true);
      expect(matchesExecutionSignature({ signatureVersion: version, legacyBasis: original }, "0".repeat(64), current, kind)).toBe(false);
    }
  });

  it.each(["account", "membership", "incarnation", "role", "source", "policy", "boot"])("rejects a captured old authority after %s changes", field => {
    const original = basis(), changed = basis();
    if (field === "account") changed.permission[4] = "9";
    if (field === "membership") changed.permission[5] = "9";
    if (field === "incarnation") changed.permission[6] = "rejoined";
    if (field === "role") changed.permission[8] = "admin";
    if (field === "source") changed.permission[10][0]!.repositoryId = "43";
    if (field === "policy") changed.policy[1] = false;
    if (field === "boot") changed.bootId = "replacement";
    expect(matchesExecutionSignature({ signatureVersion: 2, legacyBasis: original }, previous(original, 2).signature,
      executionSignatures(changed), "signature")).toBe(false);
  });
});
