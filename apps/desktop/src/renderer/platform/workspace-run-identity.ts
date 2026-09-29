import {
  runSessionId as nativeRunSessionId,
  isRunSessionId as nativeIsRunSessionId,
} from "@zeros/protocol/run-actions";
import {
  cloudScopedId,
  parseCloudScopedId,
  parseCloudWorkspaceKey,
} from "./bridge/cloud-workspace-key";
export * from "@zeros/protocol/run-actions";

export function runSessionId(folder: string, actionId?: string): string {
  const target = parseCloudWorkspaceKey(folder);
  const id = nativeRunSessionId(folder, actionId);
  return target ? cloudScopedId(target, id) : id;
}
export function isRunSessionId(id: string): boolean {
  return nativeIsRunSessionId(parseCloudScopedId(id)?.id ?? id);
}
