export interface CloudNativeHomeView {
  readonly directory: string;
  readonly skills?: true;
  readonly codexConfig?: true;
  readonly history: { readonly provider: "claude" | "cursor" | "codex"; readonly directory: string };
}
export const CLOUD_NATIVE_HOME: "/srv/zeros/home/agent";
export function cloudNativeHomeMounts(view: unknown): string[];
export function assertOwnedCloudNativeHome(view: unknown, worker: { uid: number; gid: number }): void;
export function cloudNativeBwrapWrapper(bwrap: string, view: unknown): string;
