import { getActiveBridge } from "./bridge/active-bridge";
import { WorkspaceRuntimeClient } from "./bridge/workspace-runtime-client";
import { runtimeExecutionKey } from "./bridge/ws-client";

const bridges = new WeakMap<object, number>();
let nextBridge = 0;
/** Transient file work cannot outlive an account/access generation. Unlike
 * persisted attachment ownership, this includes A → B → A session epochs. */
export function workspaceFileAccessKey(cwd: string): string {
  const bridge = getActiveBridge();
  if (bridge && !bridges.has(bridge)) bridges.set(bridge, ++nextBridge);
  return JSON.stringify([cwd.replace(/\/+$/, ""), bridge ? bridges.get(bridge) : 0,
    bridge instanceof WorkspaceRuntimeClient ? bridge.workspaceAccessKey(cwd) : bridge ? runtimeExecutionKey(bridge.executionIdentity) : null]);
}
