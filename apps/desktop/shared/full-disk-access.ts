/** Effective access for this desktop process, not a persisted TCC toggle. */
export type FullDiskAccessStatus =
  | "available"
  | "denied"
  | "unknown"
  | "unsupported";

export interface FullDiskAccessSnapshot {
  status: FullDiskAccessStatus;
}
