// Paid, opt-in provider differential through the real remote engine + ZSR
// boundary. Unlike scripts/agent-smoke.mjs this does not instantiate the
// gateway in-process: every request crosses CloudTransport, account binding,
// workspace authorization, and the attested cloud-worker boundary.

import { randomUUID } from "node:crypto";
import {
  BridgeClient,
  type BridgeMessage,
  type ClientBridgeMessage,
} from "./lib/bridge-client";
import { bridgeWsUrl, loadState, type CloudValidationState } from "./config";
import { selectCloudPrimaryWorkspaceId } from "./lib/workspace-target";
import {
  assertFullCloudBoundary,
  assertLiveAgentChallengeResponse,
  parseRequiredCloudAgents,
} from "./lib/qualification-gates";

function accountToken(): string {
  const token = process.env.ZEROS_ACCOUNT_ACCESS_TOKEN;
  if (
    !token ||
    token !== token.trim() ||
    token.length > 16_384 ||
    /[\0\r\n]/.test(token)
  ) {
    throw new Error(
      "ZEROS_ACCOUNT_ACCESS_TOKEN is required for qualified cloud account binding",
    );
  }
  return token;
}

function promptTimeoutMs(): number {
  const value = Number(
    process.env.ZEROS_CLOUD_AGENT_PROMPT_TIMEOUT_MS ?? "180000",
  );
  if (!Number.isInteger(value) || value < 30_000 || value > 10 * 60_000) {
    throw new Error(
      "ZEROS_CLOUD_AGENT_PROMPT_TIMEOUT_MS must be an integer from 30000 through 600000",
    );
  }
  return value;
}

function messageError(message: BridgeMessage): Error {
  const code = typeof message.code === "string" ? ` ${message.code}` : "";
  const detail =
    typeof message.error === "string"
      ? message.error
      : typeof message.message === "string"
        ? message.message
        : "engine rejected the request";
  return new Error(`${message.type}${code}: ${detail}`);
}

function requestFrame(
  client: BridgeClient,
  fields: ClientBridgeMessage,
  successType: string,
  timeoutMs: number,
): Promise<BridgeMessage> {
  return new Promise((resolve, reject) => {
    let requestId = "";
    let settled = false;
    const finish = (error: Error | null, message?: BridgeMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve(message!);
    };
    const unsubscribe = client.onMessage((message) => {
      if (message.requestId !== requestId) return;
      if (message.type === successType) {
        finish(null, message);
      } else if (
        message.type === "AGENT_ERROR" ||
        message.type === "AGENT_PROMPT_FAILED"
      ) {
        finish(messageError(message));
      }
    });
    const timer = setTimeout(
      () => finish(new Error(`${fields.type} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    requestId = client.sendMessage(fields);
  });
}

function textChunkForExecution(
  message: BridgeMessage,
  agentId: string,
  executionId: string,
): string {
  if (message.type !== "AGENT_SESSION_UPDATE" || message.agentId !== agentId) {
    return "";
  }
  const notification =
    message.notification &&
    typeof message.notification === "object" &&
    !Array.isArray(message.notification)
      ? (message.notification as Record<string, unknown>)
      : null;
  const update =
    notification?.update &&
    typeof notification.update === "object" &&
    !Array.isArray(notification.update)
      ? (notification.update as Record<string, unknown>)
      : null;
  const content =
    update?.content &&
    typeof update.content === "object" &&
    !Array.isArray(update.content)
      ? (update.content as Record<string, unknown>)
      : null;
  const routedExecution =
    typeof message.executionId === "string"
      ? message.executionId
      : typeof notification?.sessionId === "string"
        ? notification.sessionId
        : "";
  return routedExecution === executionId &&
    update?.sessionUpdate === "agent_message_chunk" &&
    content?.type === "text" &&
    typeof content.text === "string"
    ? content.text
    : "";
}

function makeClient(state: CloudValidationState): BridgeClient {
  return new BridgeClient({
    url: bridgeWsUrl(state.previewUrl),
    previewToken: state.engineIngress ? undefined : state.previewToken,
    cloudToken: state.cloudToken,
    accountToken: accountToken(),
    requestTimeoutMs: 30_000,
  });
}

async function qualifyAgent(
  client: BridgeClient,
  agentId: string,
  workspaceId: string,
  timeoutMs: number,
): Promise<void> {
  const marker = `ZEROS_PING_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const created = await requestFrame(
    client,
    {
      type: "AGENT_NEW_SESSION",
      source: "browser",
      agentId,
      chatId: `zsr-cloud-${agentId}-${randomUUID()}`,
      workspaceId,
    },
    "AGENT_SESSION_CREATED",
    120_000,
  );
  const session =
    created.session &&
    typeof created.session === "object" &&
    !Array.isArray(created.session)
      ? (created.session as Record<string, unknown>)
      : null;
  const executionId =
    typeof session?.executionId === "string"
      ? session.executionId
      : typeof session?.sessionId === "string"
        ? session.sessionId
        : "";
  if (!executionId) throw new Error(`${agentId} returned no execution id`);
  assertFullCloudBoundary(agentId, session?.boundary);

  let responseText = "";
  const unsubscribe = client.onMessage((message) => {
    responseText += textChunkForExecution(message, agentId, executionId);
  });
  let failure: unknown = null;
  try {
    const prompt = await requestFrame(
      client,
      {
        type: "AGENT_PROMPT",
        source: "browser",
        agentId,
        sessionId: executionId,
        executionId,
        prompt: [
          {
            type: "text",
            text: `Reply with this unique marker: ${marker}`,
          },
        ],
        userMessageId: `zsr-user-${randomUUID()}`,
        promptId: `zsr-prompt-${randomUUID()}`,
      },
      "AGENT_PROMPT_COMPLETE",
      timeoutMs,
    );
    const response =
      prompt.response &&
      typeof prompt.response === "object" &&
      !Array.isArray(prompt.response)
        ? (prompt.response as Record<string, unknown>)
        : null;
    if (response?.stopReason === "cancelled") {
      throw new Error(`${agentId} live prompt was cancelled`);
    }
    assertLiveAgentChallengeResponse(agentId, responseText, marker);
  } catch (error) {
    failure = error;
  } finally {
    unsubscribe();
    try {
      await requestFrame(
        client,
        {
          type: "AGENT_CLOSE_SESSION",
          source: "browser",
          agentId,
          sessionId: executionId,
          executionId,
        },
        "AGENT_SESSION_CLOSED",
        60_000,
      );
    } catch (cleanupError) {
      if (failure) {
        throw new AggregateError(
          [failure, cleanupError],
          `${agentId} failed and its execution did not close cleanly`,
        );
      }
      throw cleanupError;
    }
  }
  if (failure) throw failure;
  console.log(
    `  \x1b[32m✓\x1b[0m ${agentId}: full cloud-worker boundary + live prompt + teardown`,
  );
}

async function main(): Promise<void> {
  const agents = parseRequiredCloudAgents(
    process.env.ZEROS_CLOUD_REQUIRED_AGENTS,
  );
  const timeoutMs = promptTimeoutMs();
  const state = loadState();
  const client = makeClient(state);
  await client.connect();
  try {
    const workspaceId = selectCloudPrimaryWorkspaceId(
      await client.request("workspace.list"),
    );
    console.log(
      `\n  Live ZSR provider differential — ${agents.length} required agent(s)\n`,
    );
    for (const agentId of agents) {
      await qualifyAgent(client, agentId, workspaceId, timeoutMs);
    }
  } finally {
    client.close();
  }
  console.log("\n  PASS — every required live provider ran through ZSR.\n");
}

main().catch((error) => {
  console.error(
    "\n  ✗ cloud provider differential failed:\n",
    error instanceof Error ? error.message : "unknown failure",
  );
  process.exit(1);
});
