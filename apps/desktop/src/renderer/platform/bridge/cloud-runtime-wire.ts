import {
  cloudScopedId,
  cloudTargetForValue,
  cloudWorkspaceKey,
  parseCloudScopedId,
  parseCloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "./cloud-workspace-key";
import { runSessionId } from "@zeros/protocol/run-actions";
import { turnIdentitySchema } from "@zeros/protocol/changes-history";

export type WireRecord = Record<string, unknown>;
export interface CloudRuntimeScope extends CloudWorkspaceTarget {
  /** Confirmed by this engine's workspace.list, never supplied by a picker. */
  root: string;
  engineWorkspaceId: string;
}

export function record(value: unknown): WireRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WireRecord)
    : {};
}

/** Only envelope identities select a runtime. Prompt text, tools, provider
 * bindings and arbitrary file content are never traversed or interpreted. */
export function cloudRequestTarget(
  message: WireRecord,
): CloudWorkspaceTarget | null {
  const candidates: unknown[] = [];
  const collect = (value: WireRecord) => {
    for (const key of [
      "workspaceId",
      "cwd",
      "folder",
      "repoRoot",
      "chatId",
      "conversationId",
      "sourceChatId",
      "destinationChatId",
      "sessionId",
      "executionId",
      "id",
    ])
      candidates.push(value[key]);
  };
  collect(message);
  const params = record(message.params);
  collect(params);
  collect(record(params.chat));
  collect(record(params.initialChat));
  if (message.type === "WORKSPACE_REQUEST") {
    if (message.op === "turns.undoReset") candidates.push(params.resetId);
    if (message.op === "turns.list") collect(record(params.after));
    if (message.op === "git.diff" && record(params.history).kind === "turn-range") {
      collect(record(record(params.history).from));
      collect(record(record(params.history).to));
    }
  }
  let target: CloudWorkspaceTarget | null = null;
  for (const value of candidates) {
    const next = cloudTargetForValue(value);
    if (!next) continue;
    if (target && cloudWorkspaceKey(target) !== cloudWorkspaceKey(next))
      throw new Error("A request cannot cross cloud workspace boundaries");
    target = next;
  }
  return target;
}

function nativeValue(
  scope: CloudRuntimeScope,
  value: unknown,
  path = false,
): unknown {
  const target = cloudTargetForValue(value);
  if (!target) return value;
  if (cloudWorkspaceKey(scope) !== cloudWorkspaceKey(target))
    throw new Error("Cloud workspace changed before dispatch");
  const id = parseCloudScopedId(value);
  if (id) {
    const base = runSessionId(cloudWorkspaceKey(scope));
    return id.id === base || id.id.startsWith(`${base}-`)
      ? runSessionId(scope.root) + id.id.slice(base.length)
      : id.id;
  }
  const folder = parseCloudWorkspaceKey(value)!;
  if (!path) return scope.engineWorkspaceId;
  return folder.relativePath
    ? `${scope.root.replace(/\/$/, "")}/${folder.relativePath}`
    : scope.root;
}

function mapFields(
  scope: CloudRuntimeScope,
  value: WireRecord,
  direction: "in" | "out",
  chat = false,
): WireRecord {
  const mapped = { ...value };
  for (const key of [
    "chatId",
    "conversationId",
    "sourceChatId",
    "destinationChatId",
    "excludeChatId",
    ...(chat ? ["id"] : ["sessionId", "executionId"]),
  ]) {
    if (typeof value[key] !== "string" || !value[key]) continue;
    const base = runSessionId(scope.root);
    const incoming =
      value[key] === base || value[key].startsWith(`${base}-`)
        ? runSessionId(cloudWorkspaceKey(scope)) + value[key].slice(base.length)
        : value[key];
    mapped[key] =
      direction === "in"
        ? cloudScopedId(scope, incoming)
        : nativeValue(scope, value[key]);
  }
  if (typeof value.workspaceId === "string")
    mapped.workspaceId =
      direction === "in"
        ? cloudWorkspaceKey(scope)
        : nativeValue(scope, value.workspaceId);
  for (const key of ["cwd", "folder", "repoRoot"]) {
    if (typeof value[key] !== "string") continue;
    if (direction === "out") mapped[key] = nativeValue(scope, value[key], true);
    else if (
      value[key] === scope.root ||
      value[key] === scope.engineWorkspaceId
    )
      mapped[key] = cloudWorkspaceKey(scope);
    else if (value[key].startsWith(`${scope.root}/`))
      mapped[key] =
        cloudWorkspaceKey(scope) + value[key].slice(scope.root.length);
  }
  return mapped;
}

/** Only the protocol's turn identity fields are translated. Native turn IDs,
 * timestamps, provider metadata and diff contents remain opaque. */
function mapTurnIdentity(
  scope: CloudRuntimeScope,
  value: unknown,
  direction: "in" | "out",
): WireRecord {
  const identity = turnIdentitySchema.parse(value);
  const row = record(value);
  const chatId = nativeValue(scope, identity.chatId) as string;
  // Check typed nested owners before replacing native fields with UI keys.
  // Provider payloads and file rows never participate in routing.
  nativeValue(scope, row.workspaceId);
  nativeValue(scope, row.folder, true);
  const owner: WireRecord = {};
  if ("workspaceId" in row) owner.workspaceId = row.workspaceId;
  if ("folder" in row) owner.folder = row.folder;
  return {
    ...row,
    ...mapFields(scope, owner, direction),
    chatId: direction === "in" ? cloudScopedId(scope, chatId) : chatId,
  };
}

export function cloudOutgoing(
  scope: CloudRuntimeScope,
  message: WireRecord,
): WireRecord {
  const out = mapFields(scope, message, "out");
  if (message.params) {
    const original = record(message.params);
    const params = mapFields(scope, original, "out");
    if (message.op === "turns.undoReset")
      params.resetId = nativeValue(scope, original.resetId);
    if (message.op === "turns.list" && original.after)
      params.after = mapTurnIdentity(scope, original.after, "out");
    if (message.op === "git.diff" && record(original.history).kind === "turn-range") {
      const history = record(original.history);
      params.history = {
        ...history,
        from: mapTurnIdentity(scope, history.from, "out"),
        to: mapTurnIdentity(scope, history.to, "out"),
      };
    }
    if (message.op === "chats.delete")
      params.id = nativeValue(scope, original.id);
    for (const key of ["chat", "initialChat"])
      if (original[key])
        params[key] = mapFields(scope, record(original[key]), "out", true);
    if (Array.isArray(original.chats))
      params.chats = original.chats.map((row) =>
        mapFields(scope, record(row), "out", true),
      );
    if (Array.isArray(original.sessionIds))
      params.sessionIds = original.sessionIds.map((id) =>
        nativeValue(scope, id),
      );
    out.params = params;
  }
  // Host executable paths and directory grants cannot describe a cloud
  // runtime. Provider credentials retain the engine's existing admission path.
  delete out.cliBinary;
  return out;
}

export function cloudIncoming(
  scope: CloudRuntimeScope,
  message: WireRecord,
): WireRecord {
  const out = mapFields(scope, message, "in");
  if (message.session)
    out.session = mapFields(scope, record(message.session), "in");
  if (message.response)
    out.response = mapFields(scope, record(message.response), "in");
  if (message.notification)
    out.notification = mapFields(scope, record(message.notification), "in");
  if (message.request)
    out.request = mapFields(scope, record(message.request), "in");
  if (Array.isArray(message.chatIds))
    out.chatIds = message.chatIds.map((id) => cloudScopedId(scope, String(id)));
  if (Array.isArray(message.terminals))
    out.terminals = message.terminals.map((row) =>
      mapFields(scope, record(row), "in"),
    );
  if (message.type === "DB_CHANGED") {
    out.workspaceId = cloudWorkspaceKey(scope);
    out.workspaceIds = [cloudWorkspaceKey(scope)];
    out.cloudWorkspace = cloudWorkspaceKey(scope);
  }
  if (message.result && typeof message.result === "object") {
    const result = mapFields(scope, record(message.result), "in");
    if (message.op === "turns.reset" && typeof result.resetId === "string")
      result.resetId = cloudScopedId(scope, result.resetId);
    if (message.op === "turns.get" && result.turn)
      result.turn = mapTurnIdentity(scope, result.turn, "in");
    if (message.op === "turns.list" && Array.isArray(result.turns))
      result.turns = result.turns.map((turn) => mapTurnIdentity(scope, turn, "in"));
    if (message.op === "codeReview.list" && Array.isArray(result.threads))
      result.threads = result.threads.map((thread) => mapFields(scope, record(thread), "in"));
    const workspace = (row: unknown) => ({
      ...record(row),
      id: cloudWorkspaceKey(scope),
      path: cloudWorkspaceKey(scope),
      repoRoot: cloudWorkspaceKey(scope),
      placement: "cloud",
      organizationId: scope.organizationId,
    });
    if (message.op === "workspace.get")
      return { ...out, result: workspace(message.result) };
    if (Array.isArray(result.workspaces))
      result.workspaces = result.workspaces.map(workspace);
    if (result.workspace) result.workspace = workspace(result.workspace);
    for (const key of ["chats", "summaries"])
      if (Array.isArray(result[key]))
        result[key] = result[key].map((row) =>
          mapFields(scope, record(row), "in", true),
        );
    for (const key of ["chatDeletions", "messageResets"])
      if (Array.isArray(result[key]))
        result[key] = result[key].map((id) => cloudScopedId(scope, String(id)));
    if (Array.isArray(result.messages) && message.op === "db.pull")
      result.messages = result.messages.map((row) =>
        mapFields(scope, record(row), "in"),
      );
    // File arrays and patch strings are returned exactly as received.
    out.result = Array.isArray(message.result) ? message.result : result;
  }
  return out;
}
