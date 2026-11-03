import { useCallback, useEffect, useRef } from "react";
import type { CloudMcpFailure } from "@zeros/protocol/cloud-v2-relay";
import { captureCloudFailureOwner, requestCloudMcpRecovery, requestCloudProviderRecovery } from "./cloud-failure-navigation";

export function useCloudFailureRecovery({ folder, chatId, executionId, active, navigate, chooseModel, startNewSession, retryPreparation }: {
  folder: string | null | undefined;
  chatId: string | null | undefined;
  executionId: string | null | undefined;
  active: boolean;
  navigate: (page: "settings" | "customize") => void;
  chooseModel?: () => void;
  startNewSession?: () => void;
  retryPreparation?: () => Promise<void> | void;
}) {
  const owner = captureCloudFailureOwner(folder);
  const scope = JSON.stringify([owner, folder, chatId, executionId]);
  const current = useRef({ scope, active, generation: 0, mounted: true });
  if (current.current.scope !== scope || current.current.active !== active) {
    current.current = { scope, active, generation: current.current.generation + 1, mounted: current.current.mounted };
  }
  const generation = current.current.generation;
  useEffect(() => {
    current.current.mounted = true;
    return () => { current.current.mounted = false; };
  }, []);
  const ownsAction = useCallback(() => !!folder && active && current.current.mounted &&
    current.current.active && current.current.generation === generation &&
    !!owner && owner === captureCloudFailureOwner(folder), [folder, active, generation, owner]);
  const openProvider = useCallback((provider: string) => {
    if (!folder || !ownsAction() ||
        !requestCloudProviderRecovery(folder, provider, owner)) return;
    navigate("settings");
  }, [folder, ownsAction, owner, navigate]);
  const openMcpConnection = useCallback((failure: CloudMcpFailure) => {
    if (!folder || !ownsAction() ||
        !requestCloudMcpRecovery(folder, failure, owner)) return;
    navigate("customize");
  }, [folder, ownsAction, owner, navigate]);
  const openModelPicker = useCallback(() => {
    if (!ownsAction()) return;
    chooseModel?.();
  }, [ownsAction, chooseModel]);
  const startFresh = useCallback(() => {
    if (ownsAction()) startNewSession?.();
  }, [ownsAction, startNewSession]);
  const prepareAgain = useCallback(() => {
    if (ownsAction()) return retryPreparation?.();
  }, [ownsAction, retryPreparation]);
  return { openProvider, openMcpConnection: owner && active ? openMcpConnection : undefined,
    openModelPicker: owner && active && chooseModel ? openModelPicker : undefined,
    startNewSession: owner && active && startNewSession ? startFresh : undefined,
    retryPreparation: owner && active && retryPreparation ? prepareAgain : undefined };
}
