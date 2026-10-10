import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getOrganizationStoreGeneration, getTeamStoreState } from "../team/team-store";
import { toast } from "../../shared/ui/primitives/elements";
import { createCloudCredentialRemovalController } from "./cloud-credential-removal-controller";
import type { CloudCredentialRemovalTarget } from "./cloud-credential-removal";

/** The account epoch fences both requests and late responses. Closing a
 * surface stops its observations; submitted Yes remains durable on remount. */
export function useCloudCredentialRemoval(options: {
  userId: string;
  organizationId: string;
  active: boolean;
  onRemoved(target: CloudCredentialRemovalTarget): void | Promise<void>;
}) {
  const onRemoved = useRef(options.onRemoved);
  onRemoved.current = options.onRemoved;
  const active = useRef(options.active);
  active.current = options.active;
  const epoch = getOrganizationStoreGeneration();
  const scope = useMemo(() => ({ userId: options.userId, organizationId: options.organizationId, epoch }), [options.userId, options.organizationId, epoch]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const current = useCallback(() => latestScope.current === scope && scope.epoch === getOrganizationStoreGeneration() && getTeamStoreState().me?.user.id === scope.userId, [scope]);
  const controller = useMemo(() => createCloudCredentialRemovalController({ userId: scope.userId, isCurrent: current,
    onRemoved: target => onRemoved.current(target) }), [scope, current]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const reported = useRef("");
  useEffect(() => {
    if (options.active) controller.attach();
    else void controller.detach().catch(() => {});
    return () => { void controller.detach().catch(() => {}); };
  }, [controller, options.active]);
  useEffect(() => {
    const key = `${snapshot.state?.operationId}:${snapshot.error}`;
    if (options.active && current() && snapshot.error && reported.current !== key) {
      reported.current = key; toast.error(snapshot.error);
    }
  }, [options.active, snapshot.error, snapshot.state?.operationId, current]);
  const isPending = () => {
    const state = controller.snapshot().state;
    return !!state && !["removed", "cancelled", "expired"].includes(state.outcome?.state ?? "");
  };
  return { ...snapshot, current, isPending, pending: isPending(),
    async start(target: CloudCredentialRemovalTarget) {
      if (!active.current || !current()) return;
      try { await controller.start(target); }
      catch (error) { if (current()) toast.error(error instanceof Error ? error.message : "Cloud connection change failed"); }
    },
    async decide(action: "confirm" | "cancel") {
      if (!active.current || !current()) return;
      try { await controller.decide(action); }
      catch (error) { if (current()) toast.error(error instanceof Error ? error.message : "Cloud connection change failed"); }
    },
  };
}
