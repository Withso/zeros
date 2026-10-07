export function assertRegistryImageDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 1024 ||
    !/^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(value) ||
    value.includes("..") || value.includes("//"))
    throw new Error("Linux VM snapshots require a published immutable registry image digest");
}
