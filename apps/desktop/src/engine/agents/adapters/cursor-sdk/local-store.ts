// ──────────────────────────────────────────────────────────
// local-store — hand @cursor/sdk a working store on the IN-PROCESS path
// ──────────────────────────────────────────────────────────
//
// @cursor/sdk 1.0.26's DEFAULT local agent store is backed by the `node:sqlite`
// builtin (1.0.26 dropped the native `sqlite3` dep that 1.0.18 carried), which
// landed in Node 22.5. Below that, the FIRST Agent.create/resume/list throws:
//
//   "Default local agent storage requires the built-in node:sqlite module
//    (Node >= 22.13, or another runtime that implements node:sqlite)."
//
// …and only the first one says so. The SDK's failed async chunk load leaves a
// partially-initialized module behind, so every later call in the same process
// reports a bare `Cannot access 'n' before initialization` TDZ instead —
// classified UnknownAgentError, because the SDK's own node:sqlite detector keys
// on the message and a TDZ error matches neither.
//
// host/cursor-host.cjs applies this fix on the SUBPROCESS path (bun engines and
// the packaged app, whose host runs under Electron). This module is the same fix
// for the IN-PROCESS path, where the adapter awaits
// `import("@cursor/sdk")` directly — reached when the engine is not bun
// (`pnpm serve:engine` runs `node dist-engine/cli.js`) or when
// ZEROS_CURSOR_IN_PROCESS=1 forces it. Keeping the explicit store on both paths
// also avoids changing persistence behavior when the runtime's built-ins change.
//
// WHY TWO COPIES OF THE LOGIC, AND NOT ONE SHARED MODULE
// cursor-host.cjs ships as a STANDALONE file (an electron-builder
// extraResource, spawned by absolute path with no engine bundle around it), so
// it cannot require anything out of src/. The duplication is forced by that
// packaging, not chosen. Keep the two in step; the shape each one builds is
// pinned by __tests__/in-process-store.test.ts and
// host/__tests__/store-injection.test.ts respectively.
//
// JSONL UNCONDITIONALLY, on every runtime — the same call the host makes, for
// the same reason. Choosing per-runtime ("sqlite where the builtin exists")
// would hand one engine sqlite and another JSONL for the SAME workspace, and
// that dev/packaged divergence is exactly what let this reach users.
// ──────────────────────────────────────────────────────────

import type {
  CursorLocalRunDoc,
  CursorLocalStore,
  CursorSdkModule,
} from "./adapter";

/** A store as @cursor/sdk hands it back: `runs.get` is the only op we read, and
 *  JsonlLocalAgentStore exposes no `dispose()` at all (it is file-backed). */
interface RawLocalStore {
  runs: {
    get(input: {
      agentId: string;
      runId: string;
    }): Promise<CursorLocalRunDoc | null>;
  };
}

/** The slice of the real @cursor/sdk namespace this module touches. Both store
 *  members are optional so an SDK that predates them degrades to the SDK's own
 *  default resolution instead of throwing here. */
export interface RawCursorSdk {
  Agent: CursorSdkModule["Agent"];
  Cursor?: CursorSdkModule["Cursor"];
  JsonlLocalAgentStore?: new (rootDir: string) => RawLocalStore;
  getDefaultSdkStateRoot?: (workspaceRef: string) => string;
}

/** rootDir → the ONE store instance for that root. @cursor/sdk requires the
 *  SAME instance across create/resume/list for a given root, so these are
 *  memoized rather than rebuilt per call. Module-level, because the adapter
 *  memoizes the SDK module itself and every session shares it. */
const storesByRoot = new Map<string, RawLocalStore>();

function storeAt(sdk: RawCursorSdk, root: string): RawLocalStore | null {
  const Ctor = sdk.JsonlLocalAgentStore;
  if (!Ctor) return null;
  if (typeof root !== "string" || root.length === 0) return null;
  let store = storesByRoot.get(root);
  if (!store) {
    store = new Ctor(root);
    storesByRoot.set(root, store);
  }
  return store;
}

/** The workspace ref a call's store should be rooted at.
 *
 *  `cwd` is legitimately absent on `Agent.list({runtime: "local"})` —
 *  apps/desktop/src/engine/zeros-engine.ts passes `undefined` when a relay client's cwd falls
 *  outside the workspace allowlist, leaving the adapter to list the SDK's
 *  default location — and `getDefaultSdkStateRoot(undefined)` THROWS. Returning
 *  null there (so no store is injected) is what silently put `Agent.list` back
 *  on the node:sqlite default, where it threw and `listSessions` swallowed it
 *  into an empty chat list.
 *
 *  `process.cwd()` is not a guess. It is the ref the SDK itself falls back to:
 *  a store-less `Agent.list({runtime: "local"})` builds its default store at
 *  exactly `getDefaultSdkStateRoot(process.cwd())` (verified against 1.0.26).
 *  So this keeps the injected store in the SAME directory the SDK would have
 *  chosen, and only swaps the backend. */
function storeRefFor(cwd: unknown): string {
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

function storeFor(sdk: RawCursorSdk, cwd: unknown): RawLocalStore | null {
  const rootFor = sdk.getDefaultSdkStateRoot;
  if (!rootFor) return null;
  try {
    return storeAt(sdk, rootFor(storeRefFor(cwd)));
  } catch {
    // A state root we cannot compute is not worth failing the call over — the
    // SDK's own default resolution is still there to try.
    return null;
  }
}

/** Copy `opts` with our store attached at `local.store`, where
 *  Agent.create/Agent.resume take it. A caller-supplied store always wins. */
function withLocalStore(
  sdk: RawCursorSdk,
  opts: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out = { ...(opts ?? {}) };
  const local = { ...((out.local as Record<string, unknown>) ?? {}) };
  if (local.store) return out;
  const store = storeFor(sdk, local.cwd ?? out.cwd);
  if (!store) return out;
  local.store = store;
  out.local = local;
  return out;
}

/** Same, for Agent.list — whose ListAgentsOptions takes `store` at the TOP
 *  level, and only on the `runtime: "local"` arm. */
function withListStore(
  sdk: RawCursorSdk,
  opts: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out = { ...(opts ?? {}) };
  if (out.runtime !== "local" || out.store) return out;
  const store = storeFor(sdk, out.cwd);
  if (store) out.store = store;
  return out;
}

/** A store handle shaped for the adapter. Mirrors host-client's makeStore: a
 *  root we could not build reads as "no rows" rather than throwing, so
 *  readRunError degrades to null the same way on both paths. `dispose` is a
 *  no-op because the instance is shared with live agents and is file-backed —
 *  releasing the handle IS the teardown. */
function handleFor(store: RawLocalStore | null): CursorLocalStore {
  return {
    runs: { get: async (input) => (store ? store.runs.get(input) : null) },
    dispose: async () => {},
  };
}

/** Wrap the raw @cursor/sdk namespace so every store-bearing call carries one,
 *  and the adapter's `localStore.open` resolves to the SAME per-workspace
 *  instance the agents write through — so readRunError() reads the agent's own
 *  rows. The adapter programs against CursorSdkModule, so this returns the same
 *  surface the host client's `module()` does and the call sites do not branch. */
export function wrapSdkWithLocalStore(raw: RawCursorSdk): CursorSdkModule {
  return {
    Agent: {
      create: (opts) => raw.Agent.create(withLocalStore(raw, opts)),
      resume: (agentId, opts) =>
        raw.Agent.resume(agentId, withLocalStore(raw, opts)),
      list: (opts) => raw.Agent.list(withListStore(raw, opts)),
    },
    ...(raw.Cursor ? { Cursor: raw.Cursor } : {}),
    localStore: {
      open: async ({ workspaceRef, stateRoot }) =>
        handleFor(
          stateRoot ? storeAt(raw, stateRoot) : storeFor(raw, workspaceRef),
        ),
    },
  };
}
