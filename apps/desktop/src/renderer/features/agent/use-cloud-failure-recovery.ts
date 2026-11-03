import { useCallback, useRef } from "react";
import type { CloudMcpFailure } from "@zeros/protocol/cloud-v2-relay";
import { captureCloudFailureOwner, requestCloudMcpRecovery, requestCloudProviderRecovery } from "./cloud-failure-navigation";

export function useCloudFailureRecovery({ folder, chatId, executionId, active, navigate, chooseModel }: {
  folder: string | null | undefined;
  chatId: string | null | undefined;
  executionId: string | null | undefined;
  active: boolean;
  navigate: (page: "settings" | "customize") => void;
  chooseModel?: () => void;
}) {
  const owner = captureCloudFailureOwner(folder);
  const scope = JSON.stringify([owner, folder, chatId, executionId]);
  const current = useRef({ scope, active });
  current.current = { scope, active };
  const openProvider = useCallback((provider: string) => {
    if (!folder || !active || !current.current.active || current.current.scope !== scope ||
        !requestCloudProviderRecovery(folder, provider, owner)) return;
    navigate("settings");
  }, [folder, active, scope, owner, navigate]);
  const openMcpConnection = useCallback((failure: CloudMcpFailure) => {
    if (!folder || !active || !current.current.active || current.current.scope !== scope ||
        !requestCloudMcpRecovery(folder, failure, owner)) return;
    navigate("customize");
  }, [folder, active, scope, owner, navigate]);
  const openModelPicker = useCallback(() => {
    if (!folder || !active || !current.current.active || current.current.scope !== scope ||
        !owner || owner !== captureCloudFailureOwner(folder)) return;
    chooseModel?.();
  }, [folder, active, scope, owner, chooseModel]);
  return { openProvider, openMcpConnection: owner && active ? openMcpConnection : undefined,
    openModelPicker: owner && active && chooseModel ? openModelPicker : undefined };
}
