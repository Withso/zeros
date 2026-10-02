/** Explicit, paid image qualification. Run only in a disposable worker cloned
 * from the exact snapshot, through cloud-engine-launcher --qualify-agent.
 * No application RPC can invoke this entry. The host supplies one expiring,
 * engine-private input file; no credential may be baked into an image. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { chown, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderBinding } from "@zeros/protocol/identities";
import { AgentGateway } from "../../../apps/desktop/src/engine/agents/gateway";
import { createCloudAgentExecutionFactory, cloudProviderExecution, type CloudProviderExecution } from "../../../apps/desktop/src/engine/agents/cloud-provider-execution";
import { ZsrExecutionBoundary } from "../../../apps/desktop/src/engine/agents/containment/zsr-boundary";
import { loadCloudWorkerConfiguration } from "../../../apps/desktop/src/engine/agents/containment/cloud-worker-config";
import { CLOUD_NATIVE_HISTORY_ROOT } from "../../../apps/desktop/src/engine/agents/containment/cloud-native-history";
import { readCloudAgentRuntimeAttestation } from "../../../apps/desktop/src/engine/cloud-runtime-attestation";
import { NativeToolEvidence } from "../lib/native-tool-evidence";
import { parseNativeQualificationInput, nativeQualificationPermission } from "../lib/native-qualification-input";
import { nativeMcpCanarySource } from "../lib/native-mcp-canary";
import { failureSignature, forkDestinationBinding, qualificationPhrase, rawSecretObserver, runNativeMcpQualification } from "../lib/native-qualification-steps";
import type { NativeQualificationPhase } from "../lib/native-qualification-diagnostics";
import { cloudMcpDigest } from "../../../apps/desktop/src/engine/agents/cloud-mcp";
import { runNativeSmokeCanary } from "../lib/native-canary-smoke";

const inputFile = "/srv/zeros/state/.zeros-live-qualification.json";
const workspace = "/srv/zeros/workspace";
const conversationId = `native-qualification-${randomUUID()}`;
const customizationHistoryAuthority = { owner: "a".repeat(64), currentKeyVersion: 1, keys: { "1": randomBytes(32).toString("base64url") } };
const forkConversationId=`native-fork-qualification-${randomUUID()}`;
const handoffConversationId=`handoff-qualification-${randomUUID()}`;
const prefix = `.zeros-native-qualification-${randomUUID()}`;
const files = { challenge: `${prefix}.challenge`, edited: `${prefix}.edited`, executed: `${prefix}.executed` };
const marker = `QUALIFIED_${randomUUID().replaceAll("-", "")}`;
const mcpFiles = { server: `${prefix}.mcp.cjs`, proof: `${prefix}.mcp-proof` };
const mcpMarker = `MCP_${randomUUID().replaceAll("-", "")}`;
const mcpSecret = qualificationPhrase();
const rotatedMcpSecret = qualificationPhrase();
let rawHistoricalSecretObservations = 0;
const historicalSecret = rawSecretObserver(mcpSecret);
let wroteMcpConfig = false;
const checks: string[] = [];
const activity = { permissions: 0, rejectedPermissions: 0, questions: 0, messageChunks: 0, toolEvents: 0 };
let toolEvidence: ReturnType<NativeToolEvidence["summary"]> | undefined;
let failure: "timeout" | "assertion" | "runtime" | undefined, failureDetail: ReturnType<typeof failureSignature> = {};
let phase: NativeQualificationPhase = "input", gateway: AgentGateway | undefined, failed = false;
let qualificationProfile: "smoke" | "full" = "full";
let identity: { sourceCommit: string; buildSha256: string; contractSha256: string; kind: string; model: string } | undefined;
const active = new Set<CloudProviderExecution>();
const authorityChallenge = "/srv/zeros/state/.native-authority-challenge";

async function bounded<T>(operation: Promise<T>, milliseconds = 180_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("qualification deadline"), { name: "QualificationDeadline" })), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function consumeInput() {
  const fd = openSync(inputFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer | undefined;
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.uid === 0 && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size < 64 * 1024);
    bytes = readFileSync(fd);
    assert.equal(bytes.length, stat.size);
    return parseNativeQualificationInput(JSON.parse(bytes.toString("utf8")));
  } finally { bytes?.fill(0); closeSync(fd); unlinkSync(inputFile); }
}

async function main() {
  process.umask(0o077);
  const input = consumeInput();
  qualificationProfile = input.qualificationProfile ?? "full";
  const worker = loadCloudWorkerConfiguration();
  assert.equal(worker?.version, 3); assert(worker);
  const attestation = readCloudAgentRuntimeAttestation(worker);
  const buildBytes = readFileSync("/etc/zeros/image-build.json");
  const build = JSON.parse(buildBytes.toString());
  assert.equal(createHash("sha256").update(buildBytes).digest("hex"), input.buildSha256);
  assert.equal(build.source.commit, input.sourceCommit);
  const provider = input.material.kind.startsWith("claude-") ? "claude" : input.material.kind.startsWith("cursor-") ? "cursor" : "codex";
  // These are permissions to run the canary, not published qualification.
  // Each production flag is derived only from its completed check below.
  const extended = qualificationProfile === "full";
  const nativeCapabilities={version:1 as const,goals:extended&&provider==="codex",nativeFork:extended&&provider==="codex",transcriptFork:extended,
    nativeReview:extended&&provider==="codex",connectedApps:extended&&input.material.kind==="codex-chatgpt",multiAgent:extended&&provider==="codex"};
  identity = { sourceCommit: input.sourceCommit, buildSha256: input.buildSha256, contractSha256: attestation.contractSha256,
    kind: input.material.kind, model: input.model };
  const delegationId = randomUUID(), actorSessionId = randomUUID();
  const leases = new Set<string>();
  let credentialVersion = 1;
  let material = input.material;
  const gitAuthor = { name: "Zeros Qualification", email: "1234+qualification@users.noreply.github.com" };
  let revoked = false;
  const factory = createCloudAgentExecutionFactory({
    supervisor: { onRetirementFailure() { failed = true; } },
    async request(request) {
      if (request.kind === "release") { leases.delete(request.leaseId); return { released: true }; }
      assert(!revoked && Date.now() < input.expiresAtMs);
      if (request.kind === "admit") {
        const admission = request.admission;
        assert.equal(admission.provider, provider); assert.equal(admission.model, input.model);
        assert.equal(admission.delegationId, delegationId);
        assert.deepEqual(admission.source, { kind: "session", actorSessionId });
        const leaseId = randomUUID(); leases.add(leaseId);
        assert(admission.customization);
        const content = { version: 1 as const, repositoryDigest: cloudMcpDigest(admission.customization.repositoryServers),
          history: customizationHistoryAuthority,
          servers: admission.customization.repositoryServers.map(server => ({ server, scope: "repository" as const, secretRef: null, revision: 0 })),
          skills: [], cursorTeamSettings: "disabled" as const };
        return { leaseId, authorityId: "a".repeat(64), credentialVersion, credentialKind: material.kind,nativeCapabilities,
          customization: { ...content, digest: cloudMcpDigest(content) },
          provider, model: input.model, material, gitAuthor, expiresAt: new Date(Date.now() + 45_000).toISOString() };
      }
      if (request.kind === "refresh-codex") {
        assert(leases.has(request.leaseId) && input.renewedCodex && request.credentialVersion === 1);
        material = input.renewedCodex; credentialVersion = 2;
        return { leaseId: request.leaseId, credentialVersion,nativeCapabilities, expiresAt: new Date(Date.now() + 45_000).toISOString(),
          rotation: { authorityId: "a".repeat(64), material } };
      }
      assert.equal(request.kind, "validate");
      if (request.kind !== "validate") throw new Error("unsupported qualification authority");
      assert(leases.has(request.leaseId));
      return { leaseId: request.leaseId, credentialVersion,nativeCapabilities, expiresAt: new Date(Date.now() + 45_000).toISOString() };
    },
  });
  let execution: CloudProviderExecution | undefined, reply = "", binding: ProviderBinding | undefined;
  let confirmedMode: string | undefined;
  let tools = new NativeToolEvidence();
  gateway = new AgentGateway({
    projectRoot: workspace,
    executionBoundary: new ZsrExecutionBoundary({ projectRoot: workspace, cloudWorker: worker,
      cloudWorkerToolchain: worker.toolchain, supervisorScript: "/opt/zeros/binaries/zsr-supervisor.mjs" }),
    cloudAgentExecutionFactory: { async prepare(options) {
      const prepared = await factory.prepare(options);
      execution = cloudProviderExecution(prepared.boundary) ?? undefined;
      assert(execution); active.add(execution);
      const redactor = execution.redactor!;
      const redact = redactor.notification.bind(redactor);
      redactor.notification = notification => {
        if (historicalSecret.observe(notification)) rawHistoricalSecretObservations++;
        // Public redaction can truncate tool names matching a secret prefix.
        // Keep exact native evidence private and observe it only once.
        tools.observe(notification.update);
        return redact(notification);
      };
      return prepared;
    } },
    events: {
      onSessionUpdate(_agent, notification) {
        assert(!JSON.stringify(notification).includes(mcpSecret.slice(0, -1)));
        assert(!JSON.stringify(notification).includes(rotatedMcpSecret.slice(0, -1)));
        const update = notification.update;
        if (update.sessionUpdate === "provider_binding_update") binding = update.providerBinding;
        if (update.sessionUpdate === "current_mode_update") confirmedMode = update.currentModeId;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          activity.messageChunks++;
          if (reply.length + update.content.text.length > (qualificationProfile === "smoke" ? 4096 : 65536)) throw new Error("qualification response bound");
          reply += update.content.text;
        }
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") activity.toolEvents++;
      },
      onAgentStderr() {}, onAgentExit() {},
      onPermissionRequest(_agent, id, request) {
        activity.permissions++;
        // Auto mode emits a settled telemetry gate, as it does in the UI.
        // It has no pending resolver and must never be answered a second time.
        if (request.autoResolution === "allow_once") return;
        const response = nativeQualificationPermission(request, files, marker);
        if (response.outcome.outcome !== "selected") { activity.rejectedPermissions++; failed = true; }
        if (!gateway?.answerPermission(id, response)) failed = true;
      },
      onQuestionRequest(_agent, id) { activity.questions++; failed = true; gateway?.answerQuestion(id, { outcome: { outcome: "dismissed" } }); },
    },
  });
  // Match the shared composer's default. Haiku uses Accept Edits because its
  // native Claude runtime does not support Auto; Codex and Cursor use Auto.
  const initialMode = provider === "codex" ? "auto-edit" : provider === "claude" ? "accept-edits" : "auto";
  const restrictedMode = provider === "codex" ? "ask" : "plan";
  const options = { cwd: workspace, conversationId, env: { ZEROS_PERMISSION_MODE: initialMode,
    ...(qualificationProfile === "smoke" && provider === "codex" ? { ZEROS_THINKING_EFFORT: "low" } : {}) }, cloudExecution: { delegationId, model: input.model,
    source: { kind: "session" as const, actorSessionId } } };
  phase = "actor-admission";
  await assert.rejects(gateway.newSession(provider, { cwd: workspace, conversationId }));
  await assert.rejects(gateway.newSession(provider, { ...options, cloudExecution: { ...options.cloudExecution, delegationId: randomUUID() } }));
  checks.push("actorAdmission");
  await writeFile(authorityChallenge, "engine-private", { flag: "wx", mode: 0o600 });
  await writeFile(path.join(workspace, mcpFiles.server), nativeMcpCanarySource(path.join(workspace, mcpFiles.proof), mcpMarker), { flag: "wx", mode: 0o644 });
  await chown(path.join(workspace, mcpFiles.server), worker.uid, worker.gid);
  const mcpConfig = (secret?: string) => JSON.stringify({ mcpServers: { "zeros-qualification": { command: worker.toolchain.node, args: [path.join(workspace, mcpFiles.server)], env: secret ? {ZEROS_MCP_QUALIFICATION_SECRET:secret} : {} } } });
  await writeFile(path.join(workspace, ".mcp.json"), mcpConfig(mcpSecret), { flag: "wx", mode: 0o644 });
  wroteMcpConfig = true;
  phase = "native-start";
  const first = await bounded(gateway.newSession(provider, options));
  assert.equal(first.modes?.currentModeId, initialMode);
  binding = first.providerBinding ?? binding;
  assert(execution);
  const key = input.material.kind === "claude-api-key" ? "ANTHROPIC_API_KEY" : input.material.kind === "claude-setup-token" ? "CLAUDE_CODE_OAUTH_TOKEN"
    : provider === "cursor" ? "CURSOR_API_KEY" : "OPENAI_API_KEY";
  phase = "provider-home-isolation";
  const credentialProbe = input.material.kind === "codex-chatgpt"
    ? 'if(process.getuid()!==10001||["OPENAI_API_KEY","CODEX_ACCESS_TOKEN","CODEX_REFRESH_TOKEN"].some(k=>process.env[k]))process.exit(91);'
    : `if(process.getuid()!==10001||!process.env[${JSON.stringify(key)}])process.exit(91);`;
  if (input.material.kind === "codex-chatgpt") assert.deepEqual(execution.coordinator.codexExternalAuth(), input.material);
  const probe = await execution.lease.launch(() => execution!.coordinator.spawn({ command: worker.toolchain.node,
    args: ["-e", `${credentialProbe}if(process.env.HOME!=='/srv/zeros/home/agent')process.exit(92);if(require('node:fs').existsSync('/srv/zeros/state/.native-authority-challenge'))process.exit(93);`], cwd: workspace, env: {}, stdio: "pipe" }));
  probe.stdout?.resume(); probe.stderr?.resume();
  assert.equal((await bounded(probe.wait(), 10_000)).code, 0);
  await execution.lease.retire(probe);
  checks.push("privateProviderHome");
  phase = "native-git-author";
  // Exercise the actual admitted process environment without mutating the
  // workspace repository or recording an author's identity in shared config.
  const gitProbe = await execution.lease.launch(() => execution!.coordinator.spawn({ command: worker.toolchain.node,
    args: ["-e", `const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
const root=fs.mkdtempSync('/tmp/zeros-git-author-');
try{
  const git=(...args)=>cp.execFileSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','-q');git('commit','--allow-empty','-qm','Author qualification');
  assert.equal(git('show','-s','--format=%an%n%ae%n%cn%n%ce').trim(),${JSON.stringify([gitAuthor.name, gitAuthor.email, gitAuthor.name, gitAuthor.email].join("\n"))});
  assert(!git('config','--local','--list').match(/^user\\.(name|email)=/m));
}finally{fs.rmSync(root,{recursive:true,force:true});}`], cwd: workspace, env: {}, stdio: "pipe" }));
  gitProbe.stdout?.resume(); gitProbe.stderr?.resume();
  assert.equal((await bounded(gitProbe.wait(), 10_000)).code, 0);
  await execution.lease.retire(gitProbe);
  checks.push("nativeGitAuthor");
  const denial = await execution.tools.call({ operation: "exec", command: `${worker.toolchain.node} -e 'if(process.getuid()!==10001||["ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN","CURSOR_API_KEY","OPENAI_API_KEY"].some(k=>process.env[k]))process.exit(91);if(require("node:fs").existsSync("/srv/zeros/state/.native-authority-challenge"))process.exit(92);process.stdout.write("credential-denial-qualified")'` });
  assert.equal(denial.ok, true); assert.match(JSON.stringify(denial), /credential-denial-qualified/);
  checks.push("engineAuthorityIsolation");
  if (qualificationProfile === "smoke") {
    let sourceBinding: ProviderBinding | undefined;
    let resumed: Awaited<ReturnType<AgentGateway["loadSession"]>> | undefined;
    await runNativeSmokeCanary({
      async toolTurn() {
        phase = "native-turn"; reply = "";
        await writeFile(path.join(workspace, files.challenge), marker, { flag: "wx", mode: 0o644 });
        await chown(path.join(workspace, files.challenge), worker.uid, worker.gid);
        await bounded(gateway!.prompt(provider, first.sessionId, [{ type: "text", text:
          `Read ${files.challenge}. Write its exact contents to ${files.edited}, no newline. Run exactly: cat '${files.challenge}' > '${files.executed}'. Call zeros-qualification MCP probe with no arguments. Reply only with the file marker and probe marker; no explanation. Do not inspect credentials or other files.` }]));
        tools.assertEffects(provider, files, marker); tools.assertMcp("zeros-qualification", "probe");
        for (const file of [files.edited, files.executed]) assert.equal(await readFile(path.join(workspace, file), "utf8"), marker);
        assert.equal(await readFile(path.join(workspace, mcpFiles.proof), "utf8"), mcpMarker);
        assert(reply.includes(marker) && reply.includes(mcpMarker)); assert(binding);
        sourceBinding = binding; toolEvidence = tools.summary(files);
        checks.push("nativeTurn", "authentication", "nativeWorkspaceTools", "nativeMcp");
      },
      async renew() {
        if (!input.renewedCodex) return;
        phase = "access-refresh"; assert(execution);
        const next = await bounded(execution.lease.refreshCodex(1, input.renewedCodex.accountId), 10_000);
        assert.equal(next.credentialVersion, 2); assert.deepEqual(next.material, input.renewedCodex);
        assert.deepEqual(execution.coordinator.codexExternalAuth(), input.renewedCodex);
        checks.push("nativeAccessRefresh");
      },
      async retire() {
        await bounded(gateway!.endSession(provider, first.sessionId, { failClosed: true }), 20_000);
        for (const file of Object.values(files)) await rm(path.join(workspace, file), { force: true });
      },
      async resume() {
        phase = "native-resume"; assert(sourceBinding);
        reply = ""; tools = new NativeToolEvidence();
        resumed = await bounded(gateway!.loadSession(provider, sourceBinding, options));
        assert(resumed.executionId); assert.notEqual(resumed.executionId, first.executionId);
        assert.equal(resumed.modes?.currentModeId, initialMode);
      },
      async resumeTurn() {
        assert(resumed?.executionId);
        await bounded(gateway!.prompt(provider, resumed.executionId, [{ type: "text", text: "Reply only with the file marker from our previous turn. History only, no tools." }]));
        assert(reply.includes(marker)); tools.assertNoTools(); checks.push("nativeResume");
      },
      async permission() {
        phase = "permission-selection"; assert(resumed?.executionId); confirmedMode = undefined;
        await bounded(gateway!.setMode(provider, resumed.executionId, restrictedMode));
        assert.equal(confirmedMode, restrictedMode); checks.push("nativePermissionSelection");
      },
      async stop() {
        phase = "stop"; assert(execution); assert(resumed?.executionId);
        const held = await execution.lease.launch(() => execution!.coordinator.spawn({ command: worker.toolchain.node,
          args: ["-e", "setInterval(()=>{},1000)"], cwd: workspace, env: {}, stdio: "pipe" }));
        held.stdout?.resume(); held.stderr?.resume();
        await bounded(gateway!.cancel(provider, resumed.executionId), 20_000); await bounded(held.wait(), 10_000);
        assert.equal((await execution.tools.call({ operation: "exec", command: "true" })).ok, false);
        await bounded(gateway!.endSession(provider, resumed.executionId, { failClosed: true }), 20_000);
      },
      async revoke() {
        phase = "revocation"; assert(sourceBinding);
        await bounded(gateway!.loadSession(provider, sourceBinding, options)); assert(execution); revoked = true;
        await assert.rejects(execution.lease.validate()); await bounded(execution.lease.close(), 20_000);
        await assert.rejects(execution.coordinator.spawn({ command: worker.toolchain.node, args: ["-e", "process.exit(0)"], cwd: workspace, env: {} }));
        assert.equal(leases.size, 0); checks.push("stopAndRevocation");
      },
    });
    assert.equal(failed, false);
    return;
  }
  reply = "";
  await runNativeMcpQualification({
    phase(value) { phase = value; },
    async prompt() {
      await bounded(gateway!.prompt(provider, first.sessionId, [{ type: "text", text: "Call the probe tool from the zeros-qualification MCP server with no arguments. Reply with its result. Do not use shell or file tools for this check." }]));
    },
    toolEvidence() { tools.assertMcp("zeros-qualification", "probe"); },
    async proof() { assert.equal(await readFile(path.join(workspace, mcpFiles.proof), "utf8"), mcpMarker); },
    reply() { assert(reply.includes(mcpMarker)); checks.push("nativeMcp"); },
    secretObservation() { assert(rawHistoricalSecretObservations > 0); },
  });
  reply = "";
  await writeFile(path.join(workspace, files.challenge), marker, { flag: "wx", mode: 0o644 });
  await chown(path.join(workspace, files.challenge), worker.uid, worker.gid);
  phase = "native-turn";
  await bounded(gateway.prompt(provider, first.sessionId, [{ type: "text", text:
    `Use your normal native tools to read ${files.challenge}. Its contents are a unique marker. Use your native file editing tool to create ${files.edited} containing exactly that marker, with no newline. Then use your native shell tool to run exactly: cat '${files.challenge}' > '${files.executed}'. Remember the marker and reply with it. Do not inspect credentials or change any other files.` }]));
  phase = "native-tool-evidence";
  toolEvidence = tools.summary(files);
  assert(reply.includes(marker)); tools.assertEffects(provider, files, marker);
  for (const file of [files.edited, files.executed]) assert.equal(await readFile(path.join(workspace, file), "utf8"), marker);
  assert(binding); checks.push("nativeTurn", "authentication", "nativeWorkspaceTools");
  if (input.renewedCodex) {
    phase = "access-refresh";
    const next = await bounded(execution.lease.refreshCodex(1, input.renewedCodex.accountId), 10_000);
    assert.equal(next.credentialVersion, 2); assert.deepEqual(next.material, input.renewedCodex);
    assert.deepEqual(execution.coordinator.codexExternalAuth(), input.renewedCodex);
    checks.push("nativeAccessRefresh");
  }
  if(provider==="codex") {
    phase="native-goal-set";
    const goal=await bounded(gateway.setGoal(provider,first.sessionId,{objective:marker,status:"paused",tokenBudget:1000}));
    assert.equal(goal?.objective,marker);assert.equal(goal?.status,"paused");
    assert.equal((await bounded(gateway.getGoal(provider,first.sessionId)))?.objective,marker);
    if(nativeCapabilities.connectedApps) {
      phase="native-apps";
      const inventory=await bounded(gateway.readSessionToolInventory(provider,first.sessionId,workspace));
      assert.equal(inventory.groups.find(group=>group.kind==="apps")?.state,"ready");checks.push("nativeApps");
    }
  }
  const sourceBinding=binding;
  await bounded(gateway.endSession(provider, first.sessionId, { failClosed: true }), 20_000);
  if(provider==="codex") {
    phase="native-fork";
    const fork=await bounded(gateway.forkProviderBinding(provider,sourceBinding,{...options,conversationId:forkConversationId,sourceConversationId:conversationId}));
    assert.notEqual(fork.resumeId,sourceBinding.resumeId);assert.equal(fork.providerId,sourceBinding.providerId);
    const reopened=await bounded(gateway.loadSession(provider,fork,{...options,conversationId:forkConversationId}));
    assert.equal(reopened.providerBinding?.resumeId,fork.resumeId);
    assert.equal((await bounded(gateway.getGoal(provider,reopened.executionId!)))?.objective,marker);
    await bounded(gateway.clearGoal(provider,reopened.executionId!));
    await bounded(gateway.endSession(provider,reopened.executionId!,{failClosed:true}),20_000);
    checks.push("nativeFork");
  }
  phase="transcript-fork";
  // Match the application's admission-only fork: retire the empty probe and
  // leave the destination unbound. The first transcript-bearing send starts
  // a new thread; only that thread's post-turn binding is resumable.
  const handoffProbe=await bounded(gateway.newSession(provider,{...options,conversationId:handoffConversationId}));
  await bounded(gateway.endSession(provider,handoffProbe.sessionId,{failClosed:true}),20_000);
  binding=undefined;
  const handoff=await bounded(gateway.newSession(provider,{...options,conversationId:handoffConversationId}));
  reply="";
  await bounded(gateway.prompt(provider,handoff.sessionId,[{type:"text",text:`This is an explicit transcript handoff from another conversation. The user marker was ${marker}. Reply with that marker and use no tools.`}]));
  const handoffBinding=forkDestinationBinding(binding,handoff.providerBinding);
  assert(reply.includes(marker));assert(handoffBinding);assert.notEqual(handoffBinding.resumeId,sourceBinding.resumeId);
  await bounded(gateway.endSession(provider,handoff.sessionId,{failClosed:true}),20_000);
  const handoffReload=await bounded(gateway.loadSession(provider,handoffBinding,{...options,conversationId:handoffConversationId}));
  reply="";
  await bounded(gateway.prompt(provider,handoffReload.executionId!,[{type:"text",text:"Reply with the unique marker from the handoff. Use conversation history only and no tools."}]));
  assert(reply.includes(marker));
  await bounded(gateway.endSession(provider,handoffReload.executionId!,{failClosed:true}),20_000);
  checks.push("transcriptFork");
  for (const file of Object.values(files)) await rm(path.join(workspace, file), { force: true });
  reply = ""; tools = new NativeToolEvidence();
  phase = "native-resume";
  await writeFile(path.join(workspace, ".mcp.json"), mcpConfig(rotatedMcpSecret));
  const second = await bounded(gateway.loadSession(provider, sourceBinding, options));
  if(provider==="codex") {
    phase="native-goal-reload";
    assert.equal((await bounded(gateway.getGoal(provider,second.executionId!)))?.objective,marker);
    await bounded(gateway.clearGoal(provider,second.executionId!));
    assert.equal(await bounded(gateway.getGoal(provider,second.executionId!)),null);checks.push("nativeGoals");
  }
  assert.equal(second.modes?.currentModeId, initialMode);
  assert(second.executionId); assert.notEqual(second.executionId, first.executionId);
  await bounded(gateway.prompt(provider, second.executionId, [{ type: "text", text: "Reply with the exact unique marker from our previous turn. Use only your conversation history and do not call any tools." }]));
  assert(reply.includes(marker)); tools.assertNoTools(); checks.push("nativeResume");
  phase = "native-mcp-rotation";
  const beforeRotationReplay = rawHistoricalSecretObservations; historicalSecret.reset();
  await bounded(gateway.prompt(provider, second.executionId, [{type:"text",text:"Repeat verbatim the entire result of the first zeros-qualification MCP probe from our conversation history, including its second line. Do not use tools."}]));
  assert(rawHistoricalSecretObservations > beforeRotationReplay); checks.push("nativeMcpRotation");
  if(provider==="codex") {
    phase="native-review";reply="";
    await bounded(gateway.prompt(provider,second.executionId,[{type:"text",text:"/review"}]));
    assert(reply.length>0);checks.push("nativeReview");
    phase="native-multi-agent";
    tools=new NativeToolEvidence();
    await bounded(gateway.prompt(provider,second.executionId,[{type:"text",text:`Spawn exactly one agent using the same model ${input.model}, ask it to reply HELLO without using tools, wait for it, and close it. Do no other work.`}]));
    tools.assertMultiAgent(input.model);checks.push("nativeMultiAgent");
  }
  phase = "permission-selection";
  confirmedMode = undefined;
  await bounded(gateway.setMode(provider, second.executionId, restrictedMode));
  assert.equal(confirmedMode, restrictedMode);
  checks.push("nativePermissionSelection");
  phase = "stop";
  assert(execution);
  const held = await execution.lease.launch(() => execution!.coordinator.spawn({ command: worker.toolchain.node,
    args: ["-e", "setInterval(()=>{},1000)"], cwd: workspace, env: {}, stdio: "pipe" }));
  held.stdout?.resume(); held.stderr?.resume();
  await bounded(gateway.cancel(provider, second.executionId), 20_000);
  await bounded(held.wait(), 10_000);
  assert.equal((await execution.tools.call({ operation: "exec", command: "true" })).ok, false);
  await bounded(gateway.endSession(provider, second.executionId, { failClosed: true }), 20_000);
  phase = "native-mcp-removal";
  await writeFile(path.join(workspace, ".mcp.json"), mcpConfig());
  const removed = await bounded(gateway.loadSession(provider, sourceBinding, options));
  const beforeRemovalReplay = rawHistoricalSecretObservations; historicalSecret.reset();
  await bounded(gateway.prompt(provider, removed.executionId!, [{type:"text",text:"Repeat verbatim the entire result of the first zeros-qualification MCP probe, including its second line. Use only conversation history and no tools."}]));
  assert(rawHistoricalSecretObservations > beforeRemovalReplay); checks.push("nativeMcpRemoval");
  await bounded(gateway.endSession(provider, removed.executionId!, {failClosed:true}), 20_000);
  phase = "native-mcp-owner-handoff";
  customizationHistoryAuthority.owner = "b".repeat(64);
  binding = undefined;
  const otherMember = await bounded(gateway.loadSession(provider, sourceBinding, options));
  assert(otherMember.resumedFresh);
  reply = "";
  await bounded(gateway.prompt(provider, otherMember.executionId!, [{type:"text",text:"Reply with the unique QUALIFIED_ marker in the earlier scrubbed conversation context. Do not use tools."}]));
  const otherMemberBinding = binding ?? otherMember.providerBinding;
  assert(otherMemberBinding); assert.notEqual(otherMemberBinding.resumeId, sourceBinding.resumeId);
  assert(reply.includes(marker)); checks.push("nativeMcpOwnerHandoff");
  await bounded(gateway.endSession(provider, otherMember.executionId!, {failClosed:true}), 20_000);
  phase = "revocation";
  await bounded(gateway.loadSession(provider, otherMemberBinding, options));
  assert(execution); revoked = true;
  await assert.rejects(execution.lease.validate());
  await bounded(execution.lease.close(), 20_000);
  await assert.rejects(execution.coordinator.spawn({ command: worker.toolchain.node, args: ["-e", "process.exit(0)"], cwd: workspace, env: {} }));
  assert.equal(leases.size, 0); checks.push("stopAndRevocation");
  assert.equal(failed, false);
}

// Native SDK diagnostics may contain prompt or provider response text. Retain
// only the fixed phase/check report below, never arbitrary errors or output.
console.log = console.warn = console.error = () => {};
main().catch(error => {
  failed = true;
  failure = error?.name === "QualificationDeadline" ? "timeout" : error?.name === "AssertionError" ? "assertion" : "runtime";
  failureDetail = failureSignature(error);
}).finally(async () => {
  try {
    await bounded(Promise.all([...active].map(execution => execution.lease.close())), 20_000);
    await bounded(gateway?.dispose() ?? Promise.resolve(), 20_000);
    for (const file of [...Object.values(files), ...Object.values(mcpFiles)]) await rm(path.join(workspace, file), { force: true });
    if (wroteMcpConfig) await rm(path.join(workspace, ".mcp.json"), { force: true });
    await rm(authorityChallenge, { force: true });
    for(const id of [conversationId,forkConversationId,handoffConversationId])
      await rm(path.join(CLOUD_NATIVE_HISTORY_ROOT, createHash("sha256").update(id).digest("hex")), { recursive: true, force: true });
  } catch { failed = true; }
  process.stdout.write(JSON.stringify({ version: 3, qualificationProfile, executionProfile: "zeros-cloud-native-v1", qualified: !failed, phase, identity, checks,
    activity, toolEvidence, ...(failure ? { failure } : {}),
    ...(failureDetail.code ? { failureCode: failureDetail.code } : {}), ...(failureDetail.name ? { failureName: failureDetail.name } : {}),
    ...(failureDetail.kind ? { failureKind: failureDetail.kind } : {}), ...(failureDetail.stage ? { failureStage: failureDetail.stage } : {}),
    ...(failureDetail.exitCode !== undefined ? { failureExitCode: failureDetail.exitCode } : {}),
    ...(failureDetail.messageSha256 ? { failureMessageSha256: failureDetail.messageSha256 } : {}),
    qualifiedAt: new Date().toISOString(), authority: "isolated-image-canary" }) + "\n");
  process.exitCode = failed ? 1 : 0;
});
