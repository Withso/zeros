export type DaytonaSandboxClass = "container" | "linux-vm";
export type SnapshotResources = { cpu: number; memory: number; disk: number };
export type SnapshotPlacement = {
  version: 1 | 2;
  sandboxClass?: DaytonaSandboxClass;
  region?: string;
  resources?: SnapshotResources;
  registryImage?: string;
  imageRecipeSha256?: string;
};

export function parseDaytonaSandboxClass(raw: string | undefined): DaytonaSandboxClass {
  if (raw === undefined || raw === "container") return "container";
  if (raw === "linux-vm") return raw;
  throw new Error("DAYTONA_SANDBOX_CLASS must be container or linux-vm");
}

export function assertRegistryImageDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 1024 ||
    !/^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(value) ||
    value.includes("..") || value.includes("//"))
    throw new Error("Linux VM snapshots require a published immutable registry image digest");
}

/** Version 1 remains a legacy container identity. It can never qualify a VM. */
export function assertSnapshotPlacement(value: SnapshotPlacement, expected?: {
  sandboxClass: DaytonaSandboxClass; region: string; resources: SnapshotResources;
}): void {
  if (value.version === 1 && (!expected || expected.sandboxClass === "container")) return;
  if (value.version !== 2 || !["container", "linux-vm"].includes(value.sandboxClass ?? "") ||
    typeof value.region !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value.region) ||
    !value.resources || ![value.resources.cpu, value.resources.memory, value.resources.disk].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2048))
    throw new Error("Snapshot placement attestation is invalid; rebake the image");
  if (value.sandboxClass === "linux-vm") assertRegistryImageDigest(value.registryImage);
  if (expected && (value.sandboxClass !== expected.sandboxClass || value.region !== expected.region ||
    value.resources.cpu !== expected.resources.cpu || value.resources.memory !== expected.resources.memory || value.resources.disk !== expected.resources.disk))
    throw new Error("Snapshot class, region or resources changed after attestation");
}

export function vmSnapshotParameters(input: { name: string; registryImage: unknown; region: string; resources: SnapshotResources }) {
  assertRegistryImageDigest(input.registryImage);
  assertSnapshotPlacement({version:2,sandboxClass:"linux-vm",registryImage:input.registryImage,region:input.region,resources:input.resources});
  return { name: input.name, image: input.registryImage, regionId: input.region,
    sandboxClass: "linux-vm" as const, resources: input.resources };
}
