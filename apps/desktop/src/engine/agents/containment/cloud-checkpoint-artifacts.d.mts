export type NativeCheckpointBlob = { blobId: string; contentSha256: string; sizeBytes: number };
export const CLOUD_LOCAL_COMMAND_CHECKPOINT_SCOPE: "local-command-checkpoint";
export type NativeCheckpointRoots = {
  repository: string; logicalRepository?: string; agentHome?: string;
  /** Engine-owned data root. Sealed command snapshots are derived here,
   * never from repository paths, and restore with privateIdentity. */
  data?: string;
};
export type NativeCheckpointGitBase = "remote" | "none";
type NativeCheckpointFiles = {
  totalBytes: number; chunks: NativeCheckpointBlob[];
  files: Array<{ scope: string; path: string; sizeBytes: number; contentSha256: string;
    segments: Array<{ chunk: number; offset: number; sizeBytes: number }> }>;
};
export type NativeCheckpointArchive =
  | (NativeCheckpointFiles & { version: 1; gitRemoteBase?: undefined })
  | (NativeCheckpointFiles & { version: 2; gitRemoteBase: { commits: string[] } });
type Options = { roots: NativeCheckpointRoots; identity?: { uid: number; gid: number }; deadlineAtMs: number };
type CacheScope = { workspaceId: string; organizationId: string; checkpointId: string };
export type NativeCheckpointSnapshot = {
  contentRevision: number; scanFingerprint: string; nativeFingerprint: string; designSelection: string;
};
export function cloudCheckpointProjectionFingerprint(input: {
  gitBaseCommit: string | null; gitHeadRef: string | null; entries: readonly object[]; deletions: readonly string[];
}): string;
export function loadCloudNativeCheckpointCache(options: Options & { scope: CacheScope }): Promise<{
  archive: NativeCheckpointArchive; snapshot?: NativeCheckpointSnapshot;
} | null>;
export function saveCloudNativeCheckpointCache(options: Options & {
  scope: CacheScope; archive: NativeCheckpointArchive; snapshot?: NativeCheckpointSnapshot;
}): Promise<void>;
export function captureCloudNativeCheckpoint(options: Options & {
  putChunk(bytes: Uint8Array): Promise<NativeCheckpointBlob>; chunkBytes?: number; gitBase?: NativeCheckpointGitBase;
  previous?: NativeCheckpointArchive;
}): Promise<NativeCheckpointArchive>;
export function fingerprintCloudNativeCheckpoint(options: Options & { gitBase?: NativeCheckpointGitBase }): Promise<string>;
export function nativeCheckpointFingerprint(archive: NativeCheckpointArchive): string;
export function validateCloudNativeCheckpoint(raw: unknown): NativeCheckpointArchive;
export function restoreCloudNativeCheckpoint(options: Options & {
  privateIdentity?:{uid:number;gid:number};
  archive: NativeCheckpointArchive; getChunk(blobId: string): Promise<Uint8Array>;
}): Promise<void>;
