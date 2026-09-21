export type NativeCheckpointBlob = { blobId: string; contentSha256: string; sizeBytes: number };
export type NativeCheckpointRoots = { repository: string; logicalRepository?: string; agentHome?: string; data?: string };
export type NativeCheckpointArchive = {
  version: 1; totalBytes: number; chunks: NativeCheckpointBlob[];
  files: Array<{ scope: string; path: string; sizeBytes: number; contentSha256: string;
    segments: Array<{ chunk: number; offset: number; sizeBytes: number }> }>;
};
type Options = { roots: NativeCheckpointRoots; identity?: { uid: number; gid: number }; deadlineAtMs: number };
export function captureCloudNativeCheckpoint(options: Options & {
  putChunk(bytes: Uint8Array): Promise<NativeCheckpointBlob>; chunkBytes?: number;
}): Promise<NativeCheckpointArchive>;
export function validateCloudNativeCheckpoint(raw: unknown): NativeCheckpointArchive;
export function restoreCloudNativeCheckpoint(options: Options & {
  privateIdentity?:{uid:number;gid:number};
  archive: NativeCheckpointArchive; getChunk(blobId: string): Promise<Uint8Array>;
}): Promise<void>;
