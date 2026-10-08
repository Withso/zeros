import {
  cloudScopedId,
  cloudTargetForValue,
  cloudWorkspaceKey,
  parseCloudScopedId,
  parseCloudWorkspaceKey,
  isCloudWorkspace,
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

/** Local resolver envelopes stay compatible. Cloud replies always select the
 * owning peer and carry the native execution captured with the request. */
export function cloudReplyOwnership(cwd: string | null | undefined, chatId: string, request: { sessionId: string; executionId?: string }): { chatId?: string; executionId?: string } {
  return isCloudWorkspace(cwd) ? { chatId, executionId: request.executionId ?? request.sessionId } : {};
}

/** Only envelope identities select a runtime. Prompt text, tools, provider
 * bindings and arbitrary file content are never traversed or interpreted. */
export function cloudRequestTarget(
  message: WireRecord,
): CloudWorkspaceTarget | null {
  // Replica parameters describe the cloud source of a Mac-owned download.
  // Its filesystem and enrolled device belong to the Local engine even while
  // that cloud workspace has an open remote connection.
  if (message.type === "WORKSPACE_REQUEST" &&
    typeof message.op === "string" && message.op.startsWith("cloudReplica."))
    return null;
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

/** Design uses the lint report's checkout identity to fence cached snapshots.
 * Map only that typed envelope; authored paths, HTML and diagnostics are data. */
function cloudDesignReport(scope: CloudRuntimeScope, value: unknown): WireRecord {
  const report = record(value);
  if (report.workspacePath !== scope.root)
    throw new Error("Design snapshot does not match the admitted cloud checkout");
  return { ...report, workspacePath: cloudWorkspaceKey(scope) };
}

/** Only typed context ownership crosses this boundary. Preview URLs and
 * authored text remain opaque, and foreign native owners fail closed. */
function cloudDesignReference(scope: CloudRuntimeScope, value: unknown, direction: "in" | "out"): WireRecord {
  const reference = record(value);
  const key = cloudWorkspaceKey(scope);
  if (reference.workspaceId !== (direction === "in" ? scope.engineWorkspaceId : key))
    throw new Error("The Design reference belongs to another workspace.");
  return { ...reference, workspaceId: direction === "in" ? key : scope.engineWorkspaceId };
}

export function cloudOutgoing(
  scope: CloudRuntimeScope,
  message: WireRecord,
): WireRecord {
  const out = mapFields(scope, message, "out");
  if (message.params) {
    const original = record(message.params);
    const params = mapFields(scope, original, "out");
    if (message.op === "design.context.inspect" && original.reference)
      params.reference = cloudDesignReference(scope, original.reference, "out");
    // Desktop directory lifecycle calls identify their repository by root.
    // The cloud worker additionally fences them to its admitted primary row.
    if (params.workspaceId === undefined && parseCloudWorkspaceKey(original.repoRoot) &&
        ["design.previewExistingDirectory", "design.adoptDirectory", "design.renameDirectory", "design.removeDirectory"].includes(String(message.op)))
      params.workspaceId = scope.engineWorkspaceId;
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
  if (message.cloudSnapshot) {
    const snapshot = record(message.cloudSnapshot);
    out.cloudSnapshot = { ...mapFields(scope, snapshot, "in"),
      ...(snapshot.latestTurn ? { latestTurn: mapFields(scope, record(snapshot.latestTurn), "in") } : {}),
      permissions: (Array.isArray(snapshot.permissions) ? snapshot.permissions : []).map(item => ({ ...record(item), request: mapFields(scope, record(record(item).request), "in") })),
      questions: (Array.isArray(snapshot.questions) ? snapshot.questions : []).map(item => ({ ...record(item), request: mapFields(scope, record(record(item).request), "in") })),
    };
  }
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
  if (message.op === "workspace.resourceUsage" && message.type === "WORKSPACE_RESPONSE" && message.result) {
    const sample = record(message.result);
    if (sample.organizationId !== scope.organizationId || sample.workspaceId !== scope.workspaceId)
      throw new Error("Resource usage does not match the admitted cloud workspace");
    // This operation already carries the CP UUID, not a VM-native workspace
    // row/path. Preserve its exact typed identity instead of generic remapping.
    return { ...out, result: sample };
  }
  if (message.result && typeof message.result === "object") {
    const result = mapFields(scope, record(message.result), "in");
    if (typeof message.op === "string" &&
        (message.op.startsWith("design.") || message.op === "workspace.setMode")) {
      if (["design.context.create", "design.context.inspect", "design.verification.open"].includes(message.op) && result.reference)
        result.reference = cloudDesignReference(scope, result.reference, "in");
      if (result.snapshot) {
        const snapshot = record(result.snapshot);
        result.snapshot = { ...snapshot, protocolCapability: null,
          lint: cloudDesignReport(scope, snapshot.lint) };
      }
      if (record(result.mutation).lint) {
        const mutation = record(result.mutation);
        result.mutation = { ...mutation, lint: cloudDesignReport(scope, mutation.lint) };
      }
      if (message.op === "design.lint" && result.report)
        result.report = cloudDesignReport(scope, result.report);
    }
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
