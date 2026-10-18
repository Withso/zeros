import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { LocalLinkScheme } from "@zeros/protocol/local-orchestration";
import {
  useBridge,
  useBridgeStatus,
} from "../../../platform/bridge/use-bridge";
import { getActiveBridge } from "../../../platform/bridge/active-bridge";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import {
  runtimeExecutionKey,
  type RuntimeClient,
} from "../../../platform/bridge/ws-client";
import {
  readLocalLinkSnapshot,
  type LocalLinkSnapshot,
} from "../../../platform/local-link-snapshot";
import {
  openLocalLink,
  resolveLocalLinkScheme,
} from "../../../platform/local-links";
import { KeyedAsyncCache } from "../../../shared/lib/keyed-async-cache";
import { useCachedRead } from "../../../state/use-cached-read";
import { useWorkspaceStore } from "../../../state/store";
import { subscribeProjectCatalogChanges } from "../../../state/use-projects";
import { useAgentControlFeatureActive } from "../../settings/agent-control-rollout";
import { subscribeActiveTeam } from "../../team/active-team";
import {
  getActiveOrganizationIdSnapshot,
  getOrganizationStoreGeneration,
  useActiveOrganization,
} from "../../team/team-store";
import { LocalLinksContext } from "./context";
import { localLinkIndex, localLinkSourceEnabled } from "./model";

const catalog = new KeyedAsyncCache<LocalLinkSnapshot>(8);
const bridgeIds = new WeakMap<RuntimeClient, number>();
let nextBridgeId = 0;
let ownerRevision = 0;
let stopOwner: (() => void) | undefined;
const ownerListeners = new Set<() => void>();
const ownerKey = () =>
  `${getOrganizationStoreGeneration()}:${getActiveOrganizationIdSnapshot() ?? "local"}:${ownerRevision}`;
function subscribeOwner(listener: () => void) {
  ownerListeners.add(listener);
  stopOwner ??= subscribeActiveTeam(() => {
    ownerRevision++;
    for (const notify of ownerListeners) notify();
  });
  return () => {
    ownerListeners.delete(listener);
    if (ownerListeners.size === 0) {
      stopOwner?.();
      stopOwner = undefined;
      ownerRevision++;
    }
  };
}
function catalogKey(bridge: RuntimeClient, owner: string) {
  let id = bridgeIds.get(bridge);
  if (!id) bridgeIds.set(bridge, (id = ++nextBridgeId));
  return `${id}:${runtimeExecutionKey(bridge.executionIdentity)}:${owner}`;
}

/** Transcript and editor share one bounded, aggregate metadata read. Hidden
 * surfaces keep their exact-key snapshot but neither load nor listen for DB
 * changes. Every selection edge fences A → B → A responses, not just owner id. */
export function LocalLinksProvider({
  cwd,
  active = true,
  children,
}: {
  cwd: string | null | undefined;
  active?: boolean;
  children: ReactNode;
}) {
  const bridge = useBridge();
  const status = useBridgeStatus();
  const rollout = useAgentControlFeatureActive("localOrchestration");
  useActiveOrganization();
  const owner = useSyncExternalStore(subscribeOwner, ownerKey, ownerKey);
  const chats = useWorkspaceStore((state) => state.chats);
  const [scheme, setScheme] = useState<LocalLinkScheme | null>(null);
  const local =
    rollout &&
    getActiveOrganizationIdSnapshot() == null &&
    bridge?.executionIdentity.kind === "local" &&
    !!cwd &&
    !isCloudWorkspace(cwd);
  const key = local && bridge ? catalogKey(bridge, owner) : null;
  const read = useCachedRead(
    catalog,
    key,
    async (requestedKey) => {
      if (
        !active ||
        !bridge ||
        getActiveBridge() !== bridge ||
        requestedKey !== catalogKey(bridge, ownerKey()) ||
        bridge.executionIdentity.kind !== "local"
      )
        throw new Error("Local link owner changed.");
      return readLocalLinkSnapshot(bridge);
    },
    { enabled: active && status === "connected", maxAgeMs: 30_000 },
  );
  useEffect(() => {
    if (!local || !active) return;
    let current = true;
    void resolveLocalLinkScheme().then((value) => {
      if (current) setScheme(value);
    });
    return () => {
      current = false;
    };
  }, [local, active]);
  useEffect(() => {
    if (!key || !active || !bridge) return;
    const off = bridge.on("DB_CHANGED", (message) => {
      const kinds = (message as { kinds?: string[] }).kinds;
      if (
        kinds?.some(
          (kind) =>
            kind === "chats" || kind === "workspaces" || kind === "projects",
        )
      )
        catalog.invalidate(key);
    });
    const offStatus = bridge.onStatusChange(() => {
      if (bridge.status === "connected") catalog.invalidate(key);
    });
    const offCatalog = subscribeProjectCatalogChanges(() =>
      catalog.invalidate(key),
    );
    return () => {
      off();
      offStatus();
      offCatalog();
    };
  }, [bridge, key, active]);
  const index = useMemo(
    () => (read.data ? localLinkIndex(read.data, chats) : null),
    [read.data, chats],
  );
  const enabled =
    !!scheme &&
    localLinkSourceEnabled({
      rollout,
      organizationId: getActiveOrganizationIdSnapshot(),
      runtimeKind: bridge?.executionIdentity.kind,
      cwd,
      index,
    });
  const navigate = useCallback(
    (href: string) => {
      if (active && enabled) openLocalLink(href);
    },
    [active, enabled],
  );
  const value = useMemo(
    () => ({
      enabled,
      scheme: scheme ?? ("zeros" as const),
      index: enabled ? index : null,
      navigate,
    }),
    [enabled, scheme, index, navigate],
  );
  return (
    <LocalLinksContext.Provider value={value}>
      {children}
    </LocalLinksContext.Provider>
  );
}
