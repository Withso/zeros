import type {
  AgentPromptMessage,
  AgentPromptCompleteMessage,
  AgentPromptFailedMessage,
  AgentSessionLoadedMessage,
  AgentErrorMessage,
  AgentSessionUpdateMessage,
  WorkspaceResponseMessage,
} from "../../platform/bridge/messages";
import type {
  StopReason,
  TurnStateUpdateNotification,
} from "../../platform/bridge/agent-events";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import type { TurnInfo } from "../../platform/turns";

type PromptResult = AgentPromptCompleteMessage | AgentPromptFailedMessage;
type PromptRequest = Omit<AgentPromptMessage, "id" | "source" | "timestamp">;
type PromptBridge = Pick<
  RuntimeClient,
  "request" | "on" | "onStatusChange" | "status"
>;

// Match the host's bounded active-work stall allowance. A confirmed missing
// execution fails immediately; a slow shared engine is allowed to recover.
const RECONNECT_TIMEOUT_MS = 5 * 60_000;
const READ_RETRY_DELAY_MS = 1_000;

/** Hold the send queue until the recovered turn's transcript is confirmed.
 * A second socket drop or failed history read must not release a successor
 * that makes the missing history ineligible to apply. False keeps the queue
 * paused when the owner changes or the recovery window expires. */
export function backfillLocalPromptTranscript(
  bridge: Pick<PromptBridge, "status" | "onStatusChange">,
  options: {
    isCurrent: () => boolean;
    reconcile: () => Promise<boolean>;
  },
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let reading = false;
    let unsubscribe = () => {};
    const finish = (applied: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(retry);
      unsubscribe();
      resolve(applied);
    };
    const attempt = async () => {
      if (settled) return;
      if (!options.isCurrent()) {
        finish(false);
        return;
      }
      if (reading || bridge.status !== "connected") return;
      reading = true;
      try {
        const applied = await options.reconcile();
        if (!options.isCurrent()) finish(false);
        else if (applied && bridge.status === "connected") finish(true);
      } catch {
        // Retry reads only. A completed turn must never be replayed to repair
        // a missing transcript response.
      } finally {
        reading = false;
      }
    };
    const deadline = setTimeout(() => finish(false), RECONNECT_TIMEOUT_MS);
    // Also release an obsolete owner while offline or waiting on a read.
    const retry = setInterval(() => void attempt(), READ_RETRY_DELAY_MS);
    unsubscribe = bridge.onStatusChange((status) => {
      if (status === "connected") void attempt();
    });
    void attempt();
  });
}

/** Delivery is uncertain. The caller must retain the turn, never resend it. */
export class LocalPromptRecoveryError extends Error {
  constructor(
    message: string,
    readonly executionId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function disconnected(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    (error as Error & { code?: string }).code === "ENGINE_SWAPPING" ||
    error.message === "Request timeout: engine disconnected"
  );
}

function interruptedRead(error: unknown): boolean {
  return (
    disconnected(error) ||
    (error instanceof Error &&
      /^Request timeout: (?:AGENT_LOAD_SESSION|WORKSPACE_REQUEST)(?: \(reconnecting\))?$/.test(
        error.message,
      ))
  );
}

/** Re-adopt an engine-owned Local turn after losing its response socket.
 * Only AGENT_PROMPT is a write: it is sent once. Reconnects use adoptOnly and
 * exact-turn reads, including when completion happened while we were offline. */
export function requestLocalPrompt(
  bridge: PromptBridge,
  message: PromptRequest,
  options: {
    chatId: string;
    signal: AbortSignal;
    isCurrent: () => boolean;
    onRecovery?: () => void;
  },
): Promise<PromptResult> {
  return new Promise((resolve, reject) => {
    const executionId = message.executionId ?? message.sessionId;
    const controller = new AbortController();
    const unsubscribers: (() => void)[] = [];
    let settled = false;
    let recovering = false;
    let needsAdoption = false;
    let transportEpoch = 0;
    let adoption: Promise<void> | null = null;
    let completing = false;
    let terminal: TurnStateUpdateNotification | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (retry) clearTimeout(retry);
      options.signal.removeEventListener("abort", abort);
      for (const unsubscribe of unsubscribers) unsubscribe();
      controller.abort();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(new DOMException("Prompt observation was cancelled", "AbortError"));
    const current = () => {
      if (settled) return false;
      if (options.signal.aborted || !options.isCurrent()) {
        abort();
        return false;
      }
      return true;
    };
    const finish = (result: PromptResult) => {
      if (!current()) return;
      cleanup();
      resolve(result);
    };
    const armDeadline = () => {
      if (deadline) return;
      deadline = setTimeout(() => {
        if (current())
          fail(
            new LocalPromptRecoveryError(
              "The engine connection could not be restored. Reconnect to check this turn before retrying.",
              executionId,
            ),
          );
      }, RECONNECT_TIMEOUT_MS);
    };
    const retryRead = () => {
      needsAdoption = true;
      armDeadline();
      if (retry) return;
      // Back off even if the socket is still connected: read timeouts under
      // load must not create a tight request loop or authorize a prompt replay.
      retry = setTimeout(() => {
        retry = null;
        adopt();
      }, READ_RETRY_DELAY_MS);
    };
    const readTurn = async (): Promise<TurnInfo | null> => {
      if (!message.userMessageId) return null;
      const response = await bridge.request<WorkspaceResponseMessage>(
        {
          type: "WORKSPACE_REQUEST",
          op: "turns.get",
          params: { chatId: options.chatId, turnId: message.userMessageId },
        },
        { timeoutMs: 10_000, signal: controller.signal },
      );
      if (response.type !== "WORKSPACE_RESPONSE") return null;
      const turn = (response.result as { turn?: TurnInfo | null } | undefined)
        ?.turn;
      return turn?.chatId === options.chatId &&
        turn.turnId === message.userMessageId &&
        (!turn.agentId || turn.agentId === message.agentId)
        ? turn
        : null;
    };
    const complete = async () => {
      if (!current() || completing) return;
      completing = true;
      const epoch = transportEpoch;
      let turn: TurnInfo | null = null;
      try {
        turn = await readTurn();
      } catch (error) {
        // Losing a read is not evidence that the engine lost the turn. A
        // terminal push is sufficient; otherwise reconnect and read it again.
        if (
          !terminal &&
          current() &&
          (interruptedRead(error) ||
            epoch !== transportEpoch ||
            bridge.status !== "connected")
        ) {
          completing = false;
          retryRead();
          return;
        }
      }
      completing = false;
      if (!current()) return;
      const state = terminal?.state ?? turn?.status;
      if (state !== "completed" && state !== "cancelled") {
        fail(
          new LocalPromptRecoveryError(
            state === "failed"
              ? "The agent turn failed while the engine connection was unavailable. Its saved transcript has the details."
              : "The engine no longer has this running turn. Its saved conversation is available to continue.",
            executionId,
          ),
        );
        return;
      }
      const stopReason =
        state === "cancelled"
          ? "cancelled"
          : ((terminal?.stopReason ??
              turn?.stopReason ??
              "end_turn") as StopReason);
      finish({
        id: `recovered-${message.promptId ?? message.userMessageId}`,
        source: "engine",
        timestamp: Date.now(),
        type: "AGENT_PROMPT_COMPLETE",
        requestId: message.promptId ?? "",
        agentId: message.agentId,
        executionId,
        sessionId: executionId,
        stopReason,
        response: { stopReason, ...(turn?.usage ? { usage: turn.usage } : {}) },
      });
    };
    const adopt = () => {
      if (
        !current() ||
        !needsAdoption ||
        adoption ||
        retry ||
        bridge.status !== "connected"
      )
        return;
      const epoch = transportEpoch;
      const flight = (async () => {
        try {
          const loaded = await bridge.request<
            AgentSessionLoadedMessage | AgentErrorMessage
          >(
            {
              type: "AGENT_LOAD_SESSION",
              agentId: message.agentId,
              executionId,
              chatId: options.chatId,
              adoptOnly: true,
            },
            { timeoutMs: 20_000, signal: controller.signal },
          );
          if (!current() || epoch !== transportEpoch) return;
          if (
            loaded.type === "AGENT_SESSION_LOADED" &&
            loaded.agentId === message.agentId &&
            (loaded.executionId ?? loaded.sessionId) === executionId &&
            loaded.sessionId === executionId &&
            loaded.promptActive === true &&
            loaded.promptId === message.promptId &&
            message.promptId
          ) {
            needsAdoption = false;
            if (deadline) clearTimeout(deadline);
            deadline = null;
            if (terminal) await complete();
          } else {
            // The turn may have finished before adoption, or the engine may
            // have restarted. A saved terminal row distinguishes those cases.
            await complete();
          }
        } catch (error) {
          if (!current() || epoch !== transportEpoch) return;
          if (interruptedRead(error)) {
            retryRead();
            return;
          }
          fail(
            new LocalPromptRecoveryError(
              "The engine connection could not be restored. Reconnect to check this turn before retrying.",
              executionId,
              { cause: error },
            ),
          );
        }
      })().finally(() => {
        if (adoption === flight) adoption = null;
        if (!settled && needsAdoption) adopt();
      });
      adoption = flight;
    };

    options.signal.addEventListener("abort", abort, { once: true });
    if (!current()) return;
    unsubscribers.push(
      bridge.on("AGENT_SESSION_UPDATE", (raw) => {
        const event = raw as AgentSessionUpdateMessage;
        const notification = event.notification;
        if (
          event.agentId !== message.agentId ||
          (event.chatId !== undefined && event.chatId !== options.chatId) ||
          (event.executionId !== undefined &&
            event.executionId !== executionId) ||
          notification.sessionId !== executionId ||
          (notification.executionId !== undefined &&
            notification.executionId !== executionId)
        )
          return;
        const update = notification.update;
        if (
          update.sessionUpdate !== "turn_state" ||
          update.turnId !== message.userMessageId ||
          update.state === "running"
        )
          return;
        terminal = update;
        if (recovering) void complete();
      }),
    );
    unsubscribers.push(
      bridge.onStatusChange((status) => {
        if (status === "disconnected") {
          transportEpoch++;
          needsAdoption = true;
          if (recovering) armDeadline();
        } else if (status === "connected" && recovering) adopt();
      }),
    );
    void bridge
      .request<PromptResult>(message, {
        timeoutMs: 0,
        signal: controller.signal,
      })
      .then((response) => {
        if (settled) return;
        // This is the original correlated receipt, including a native Stop
        // acknowledgement. Preserve the caller's normal response path after
        // its send generation changes, so delivered history is not replayed
        // on the next send. Recovery reads still require current ownership.
        cleanup();
        resolve(response);
      }, (error) => {
        if (!current()) return;
        if (!disconnected(error)) {
          fail(error);
          return;
        }
        recovering = true;
        options.onRecovery?.();
        needsAdoption = true;
        armDeadline();
        if (terminal) void complete();
        else adopt();
      });
  });
}
