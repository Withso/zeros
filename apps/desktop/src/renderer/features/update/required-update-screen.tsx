import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { nativeInvoke } from "../../platform/runtime";
import type { UpdaterStatus } from "../../platform/updater";
import {
  agentSessionHasActiveWork,
  useSessionsStore,
} from "../agent/sessions-store";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives";
import {
  isDesktopVersionAtLeast,
  type ClientUpgradeRequired,
} from "../../../../shared/client-compatibility";
import {
  requiredUpdateReady,
  scheduleRequiredUpdateRestart,
} from "./required-update-state";
import { useNativeSurfaceOverlayIntent } from "../../shared/ui/native-surface-overlay";
import { claimShortcutPriority } from "../agent/shortcut-priority";

function agentsAreWorking(state = useSessionsStore.getState()): boolean {
  return (
    Object.entries(state.sessions).some(
      ([chatId, slot]) =>
        slot.status === "warming" ||
        slot.status === "streaming" ||
        slot.status === "reconnecting" ||
        agentSessionHasActiveWork(slot, state.pendingLocalTurns[chatId]),
    ) || Object.values(state.pendingLocalTurns).some(Boolean)
  );
}

export function RequiredUpdateScreen({
  required,
  status,
  install,
}: {
  required: ClientUpgradeRequired;
  status: UpdaterStatus;
  install: (options?: { requireReady: boolean }) => Promise<void>;
}) {
  const anyAgentRunning = useSessionsStore(agentsAreWorking);
  const publishOverlay = useNativeSurfaceOverlayIntent();
  useLayoutEffect(() => {
    const releaseKeyboard = claimShortcutPriority();
    publishOverlay(true);
    return () => {
      publishOverlay(false);
      releaseKeyboard();
    };
  }, [publishOverlay]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const ready = requiredUpdateReady(status, required);
  const check = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const update = await nativeInvoke<{ version: string } | null>(
        "updater_check",
      );
      if (
        !update ||
        !isDesktopVersionAtLeast(update.version, required.minimumVersion)
      )
        setCheckError(
          "A compatible update is not available yet. Check again shortly.",
        );
    } catch {
      setCheckError(
        "Could not check for updates. Check your connection and try again.",
      );
    } finally {
      setChecking(false);
    }
  }, [required.minimumVersion]);

  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => {
    if (!ready || anyAgentRunning) return;
    return scheduleRequiredUpdateRestart(
      () => !agentsAreWorking(),
      () => {
        void install({ requireReady: true });
      },
    );
  }, [ready, anyAgentRunning, install]);

  const progress =
    status.kind === "downloading" && status.total && status.total > 0
      ? `${Math.min(100, Math.max(0, Math.round((status.downloaded / status.total) * 100)))}%`
      : null;
  const updateState = ready
    ? "Update ready to install."
    : status.kind === "downloading"
      ? `Downloading the update${progress ? ` (${progress})` : ""}…`
      : status.kind === "error"
        ? status.message
        : checking || status.kind === "checking"
          ? "Checking for updates…"
          : "Waiting for a compatible update.";
  const message =
    ready ||
    status.kind === "downloading" ||
    status.kind === "checking" ||
    status.kind === "available" ||
    status.kind === "error"
      ? updateState
      : (checkError ?? updateState);

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        dismissable={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onKeyDown={(event) => event.stopPropagation()}
        data-required-update-screen
      >
        <DialogHeader>
          <DialogTitle>Update required</DialogTitle>
          <DialogDescription>
            This version of Zeros is no longer supported. Update Zeros to
            continue.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {required.latestVersion && (
            <p className="text-fg2 m-0 text-xs">
              Latest version: {required.latestVersion}
            </p>
          )}
          <p className="text-fg1 m-0 text-sm" role="status" aria-live="polite">
            {message}
          </p>
          <p className="text-fg2 m-0 text-xs">
            {anyAgentRunning
              ? "Your agents keep working while the update downloads. Zeros waits for them to finish before restarting automatically. Restart now interrupts running work."
              : "Zeros restarts automatically once the update is ready and all agents have been idle for 30 seconds."}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={checking || status.kind === "downloading"}
            onClick={() => {
              void check();
            }}
          >
            Check again
          </Button>
          <Button
            disabled={!ready}
            onClick={() => {
              void install({ requireReady: true });
            }}
          >
            Restart now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
