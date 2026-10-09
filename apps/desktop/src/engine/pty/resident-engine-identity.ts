/** New resident entry uses the fixed non-root engine account. Runtime lookup
 * separately verifies the exact admitted namespace, immutable pin and scope. */
export function assertResidentEngineIdentity(identity: {
  platform: string; uid: number | undefined; gid: number | undefined; groups: readonly number[] | undefined;
}): void {
  if (identity.platform !== "linux" || identity.uid !== 10003 || identity.gid !== 10003 ||
      !identity.groups || identity.groups.length !== 0)
    throw new Error("Resident namespace required");
}
