// Paid, opt-in provider differential through the real remote engine + ZSR
// boundary. Unlike scripts/agent-smoke.mjs this does not instantiate the
// gateway in-process: every request crosses CloudTransport, account binding,
// workspace authorization, and the attested cloud-worker boundary.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BridgeClient,
  type BridgeMessage,
  type ClientBridgeMessage,
} from "./lib/bridge-client";
import { bridgeWsUrl, loadState, type CloudValidationState } from "./config";
import { selectCloudPrimaryWorkspaceId } from "./lib/workspace-target";
import {runPtyCommand} from "./lib/pty-command";
import { CoreToolEvidence } from "./lib/core-tool-evidence";
import {
  assertFullCloudBoundary,
  assertCloudCoreBoundary,
  assertCloudAgentModel,
  assertLiveAgentChallengeResponse,
  parseRequiredCloudAgents,
  parseCloudAgentSelections,
  type CloudAgentSelection,
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

type QualificationClient = Pick<BridgeClient, "onMessage" | "sendMessage"> &
  Partial<Pick<BridgeClient, "request" | "engineCapabilities" | "ptyCreate" | "ptyWrite" | "onPtyData">>;

export type CloudAgentQualificationProfile = "full-native" | "zeros-cloud-core-v1";
function assertExpectedBoundary(agentId:string,raw:unknown,profile:CloudAgentQualificationProfile):void{
  if(profile==="zeros-cloud-core-v1")assertCloudCoreBoundary(agentId,raw);
  else assertFullCloudBoundary(agentId,raw);
}

async function qualifyDurableAgent(
  client: QualificationClient,
  selection: CloudAgentSelection,
  workspaceId: string,
  timeoutMs: number,
  profile: CloudAgentQualificationProfile,
): Promise<void> {
  if (!client.request || !selection.agentCredentialGrantId)
    throw new Error(
      "Durable cloud qualification requires an explicit agent credential delegation",
    );
  const request = client.request.bind(client);
  const conversationId = `zsr-cloud-${selection.agentId}-${randomUUID()}`;
  const marker = `ZEROS_PING_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const effort = selection.env.ZEROS_THINKING_EFFORT;
  const core = profile === "zeros-cloud-core-v1";
  const prefix = `zeros-core-qualification-${randomUUID()}`;
  const files = {challenge:`${prefix}.challenge`,edited:`${prefix}.edited`,executed:`${prefix}.executed`};
  const terminalClient = client.ptyCreate && client.ptyWrite && client.onPtyData ? {
    ptyCreate:client.ptyCreate.bind(client),ptyWrite:client.ptyWrite.bind(client),onPtyData:client.onPtyData.bind(client),
  } : null;
  if(core&&!terminalClient)throw new Error("Core qualification requires a cleanup-capable workspace terminal");
  if (
    effort !== undefined &&
    !["low", "medium", "high", "xhigh"].includes(effort)
  )
    throw new Error("Unsupported durable qualification effort");
  let activeCommandId: string | null = null,
    failure: unknown = null;
  const executions = new Set<string>();
  const waitForReceipt = async (
    commandId: string,
    success: boolean,
    waitMs = 15_000,
    signal?: AbortSignal,
  ) => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      signal?.throwIfAborted();
      const value = (await request("cloudCommands.request", {
        request: { kind: "read", commandId },
      })) as { state?: string };
      signal?.throwIfAborted();
      if (
        value.state === "succeeded" ||
        (!success && ["failed", "cancelled"].includes(value.state ?? ""))
      )
        return;
      if (
        !["queued", "dispatching"].includes(value.state ?? "") ||
        Date.now() >= deadline
      )
        throw new Error(
          "Cloud command did not durably settle after retirement",
        );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  try {
    if(core)await request("file.write",{workspaceId,path:files.challenge,content:marker});
    await request("cloudCommands.createConversation", {
      conversationId,
      workspaceId,
      agentId: selection.agentId,
      model: selection.model,
    });
    // Each command obtains a fresh execution and lease. The second prompt omits
    // the marker, so only genuine native history continuation can answer it.
    for (const promptText of [
      core ? `Use the Zeros workspace tools to read ${files.challenge}. Its contents are a unique marker. Use a file tool to create ${files.edited} containing exactly the marker, with no newline. Then use a workspace command tool to run: cat '${files.challenge}' > '${files.executed}'. Remember the marker and reply with it. Do not inspect credentials or change other files.` : `Remember this unique marker and reply with it: ${marker}`,
      "Reply with the exact unique marker from our previous turn in this conversation. Use only your conversation history; do not call any tools.",
    ]) {
      const snapshot = (await request("cloudCommands.request", {
        request: { kind: "snapshot", conversationId },
      })) as { revision?: number };
      if (
        !Number.isSafeInteger(snapshot.revision) ||
        (snapshot.revision ?? -1) < 0
      )
        throw new Error("Invalid durable queue revision");
      const commandId = randomUUID();
      activeCommandId = commandId;
      let executionId = "",
        responseText = "",
        boundary: unknown,
        settled = false;
      const toolEvidence = new CoreToolEvidence();
      let unsubscribe = () => {};
      const receiptPoll = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const terminal = new Promise<BridgeMessage>((resolve, reject) => {
        unsubscribe = client.onMessage((message) => {
          if (settled) return;
          if (
            message.requestId === commandId &&
            message.agentId === selection.agentId &&
            ["AGENT_SESSION_CREATED", "AGENT_SESSION_LOADED"].includes(
              message.type,
            )
          ) {
            const session = (message.session ?? message.response) as
              | Record<string, unknown>
              | undefined;
            executionId = String(
              message.executionId ??
                session?.executionId ??
                session?.sessionId ??
                "",
            );
            boundary = session?.boundary;
            try {
              assertExpectedBoundary(selection.agentId, boundary,profile);
            } catch (error) {
              settled = true;
              reject(error);
              return;
            }
          }
          const chunk = executionId
            ? textChunkForExecution(message, selection.agentId, executionId)
            : "";
          if(message.type==="AGENT_SESSION_UPDATE"&&message.agentId===selection.agentId&&message.executionId===executionId){
            const notification=message.notification as {update?:unknown}|undefined;
            try { if (core) toolEvidence.observe(notification?.update); }
            catch (error) { settled = true; reject(error); return; }
          }
          if (
            Buffer.byteLength(responseText) + Buffer.byteLength(chunk) >
            65536
          ) {
            settled = true;
            reject(new Error("Qualification output exceeded its bound"));
            return;
          }
          responseText += chunk;
          if (message.requestId !== commandId) return;
          if (message.type === "AGENT_PROMPT_COMPLETE") {
            settled = true;
            resolve(message);
          } else if (
            message.type === "AGENT_PROMPT_FAILED" ||
            message.type === "AGENT_ERROR"
          ) {
            settled = true;
            reject(messageError(message));
          }
        });
        timer = setTimeout(() => {
          settled = true;
          reject(new Error("Durable cloud prompt timed out"));
        }, timeoutMs);
      });
      void terminal.catch(() => {});
      try {
        await request("cloudCommands.request", {
          request: {
            kind: "mutate",
            mutation: {
              conversationId,
              operationId: randomUUID(),
              expectedRevision: snapshot.revision,
              action: {
                kind: "enqueue",
                commandId,
                payload: {
                  agentId: selection.agentId,
                  agentCredentialGrantId: selection.agentCredentialGrantId,
                  model: selection.model,
                  ...(effort ? { effort } : {}),
                  fast: selection.env.ZEROS_FAST_MODE === "1",
                  modeRevision: 0,
                  userMessageId: randomUUID(),
                  prompt: [{ type: "text", text: promptText }],
                },
              },
            },
          },
        });
        const [completed] = await Promise.all([
          terminal,
          waitForReceipt(commandId, true, timeoutMs, receiptPoll.signal),
        ]);
        activeCommandId = null;
        if (!executionId || executions.has(executionId))
          throw new Error("A fresh cloud execution identity was not observed");
        executions.add(executionId);
        assertExpectedBoundary(selection.agentId, boundary,profile);
        const response = completed.response as Record<string, unknown> | null;
        if (response?.stopReason === "cancelled")
          throw new Error("Cloud live prompt was cancelled");
        assertCloudAgentModel(selection, response);
        assertLiveAgentChallengeResponse(
          selection.agentId,
          responseText,
          marker,
        );
        if(core&&executions.size===1){
          toolEvidence.assertEffects(selection.agentId, files, marker);
          for(const file of [files.edited,files.executed]){
            const value=await request("file.read",{workspaceId,path:file}) as {content?:unknown};
            if(value.content!==marker)throw new Error("Core qualification workspace file or process effect did not match");
          }
          await runPtyCommand(terminalClient!,workspaceId,`rm -f -- '${files.challenge}' '${files.edited}' '${files.executed}'`);
          for (const file of Object.values(files)) {
            const value = await request("file.read", { workspaceId, path: file }) as {kind?:unknown; error?:unknown; content?:unknown};
            if (value.kind !== "error" || value.error !== "file no longer exists on disk" || value.content !== undefined)
              throw new Error("Core qualification challenge removal was not verified");
          }
        }
        if (core && executions.size === 2) toolEvidence.assertNoTools();
      } finally {
        receiptPoll.abort();
        if (timer) clearTimeout(timer);
        unsubscribe();
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await request("cloudCommands.request", {
        request: { kind: "stop", conversationId, operationId: randomUUID() },
      });
      if (activeCommandId) await waitForReceipt(activeCommandId, false);
      if(core&&terminalClient)await runPtyCommand(terminalClient,workspaceId,`rm -f -- '${files.challenge}' '${files.edited}' '${files.executed}'`);
    } catch (cleanupError) {
      throw new AggregateError(
        failure ? [failure, cleanupError] : [cleanupError],
        "Cloud qualification cleanup could not prove durable retirement",
      );
    }
  }
  if (failure) throw failure;
  console.log(
    `  ✓ ${selection.agentId}: ${profile}, delegated cold turns, ${core?"observed workspace tool effects, ":""}native continuation and durable retirement`,
  );
}

function requestFrame(
  client: QualificationClient,
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
    try {
      requestId = client.sendMessage(fields);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Bridge send failed"));
    }
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

export async function qualifyAgent(
  client: QualificationClient,
  selection: CloudAgentSelection,
  workspaceId: string,
  timeoutMs: number,
  profile: CloudAgentQualificationProfile = "full-native",
): Promise<void> {
  if(profile!=="full-native"&&profile!=="zeros-cloud-core-v1")throw new Error("Unknown cloud qualification profile");
  const { agentId } = selection;
  const marker = `ZEROS_PING_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const conversationId = `zsr-cloud-${agentId}-${randomUUID()}`;
  const durable =
    client.engineCapabilities?.includes("cloud.commands.v1") === true;
  if (durable)
    return qualifyDurableAgent(client, selection, workspaceId, timeoutMs,profile);
  if(profile!=="full-native")throw new Error("Core qualification requires the durable v3 admission path");
  const created = await requestFrame(
    client,
    {
      type: "AGENT_NEW_SESSION",
      source: "browser",
      agentId,
      chatId: conversationId,
      workspaceId,
      env: selection.env,
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

  let responseText = "";
  const unsubscribe = client.onMessage((message) => {
    responseText += textChunkForExecution(message, agentId, executionId);
  });
  let failure: unknown = null;
  try {
    assertFullCloudBoundary(agentId, session?.boundary);
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
    assertCloudAgentModel(selection, response);
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
  const selections = parseCloudAgentSelections(
    agents,
    process.env.ZEROS_CLOUD_AGENT_SELECTIONS,
  );
  const timeoutMs = promptTimeoutMs();
  const profile=process.env.ZEROS_CLOUD_AGENT_BOUNDARY_PROFILE??"full-native";
  if(profile!=="full-native"&&profile!=="zeros-cloud-core-v1")throw new Error("Unknown cloud qualification profile");
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
    for (const selection of selections) {
      await qualifyAgent(client, selection, workspaceId, timeoutMs,profile);
    }
  } finally {
    client.close();
  }
  console.log("\n  PASS — every required live provider ran through ZSR.\n");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(
      "\n  ✗ cloud provider differential failed:\n",
      error instanceof Error ? error.message : "unknown failure",
    );
    process.exit(1);
  });
