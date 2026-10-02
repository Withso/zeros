import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failureSignature, forkDestinationBinding, qualificationPhrase, rawSecretObserver, runNativeMcpQualification } from "../cloud-workspace-validation/lib/native-qualification-steps";
import { NativeToolEvidence } from "../cloud-workspace-validation/lib/native-tool-evidence";
import type { NativeQualificationPhase } from "../cloud-workspace-validation/lib/native-qualification-diagnostics";

const mcpSteps = [
  { step: "prompt", phase: "native-mcp-prompt" },
  { step: "toolEvidence", phase: "native-mcp-tool-evidence" },
  { step: "proof", phase: "native-mcp-proof" },
  { step: "reply", phase: "native-mcp-reply" },
  { step: "secretObservation", phase: "native-mcp-secret-observation" },
] as const;
const mcpRoots: string[] = [];
afterEach(async () => { await Promise.all(mcpRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function mcpFixture(input: { failedStep?: typeof mcpSteps[number]["step"] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-mcp-diagnostic-")); mcpRoots.push(root);
  const marker = "MCP_OWNED_SYNTHETIC_MARKER", proof = path.join(root, "proof"), tools = new NativeToolEvidence();
  const trace: { step: string; phase: NativeQualificationPhase }[] = [], checks: string[] = [];
  let phase: NativeQualificationPhase = "input", reply = "";
  const observe = (step: string) => { trace.push({ step, phase }); };
  return { trace, checks, steps: {
    phase(value: NativeQualificationPhase) { phase = value; },
    async prompt() {
      observe("prompt"); if (input.failedStep === "prompt") throw new Error("synthetic prompt failure");
      tools.observe({ sessionUpdate: "tool_call", toolCallId: "owned-probe", nativeToolCallId: "native-owned-probe",
        kind: "mcp", status: "in_progress", rawInput: { server: "zeros-qualification", tool: "probe", arguments: {} } });
      tools.observe({ sessionUpdate: "tool_call_update", toolCallId: "owned-probe", status: input.failedStep === "toolEvidence" ? "failed" : "completed" });
      await writeFile(proof, input.failedStep === "proof" ? "wrong marker" : marker);
      reply = input.failedStep === "reply" ? "missing marker" : marker;
    },
    toolEvidence() { observe("toolEvidence"); tools.assertMcp("zeros-qualification", "probe"); },
    async proof() { observe("proof"); assert.equal(await readFile(proof, "utf8"), marker); },
    reply() { observe("reply"); assert(reply.includes(marker)); checks.push("nativeMcp"); },
    secretObservation() { observe("secretObservation"); assert(input.failedStep !== "secretObservation"); },
  } };
}

describe("first FULL native MCP diagnostic ordering", () => {
  it("labels each unchanged operation in order without repeating calls or changing the nativeMcp append", async () => {
    const fixture = await mcpFixture();
    await runNativeMcpQualification(fixture.steps);
    expect(fixture.trace).toEqual(mcpSteps);
    expect(fixture.checks).toEqual(["nativeMcp"]);
  });
  it.each(mcpSteps)("labels the actual $step failure and never runs later operations", async ({ step, phase }) => {
    const fixture = await mcpFixture({ failedStep: step });
    await expect(runNativeMcpQualification(fixture.steps)).rejects.toThrow();
    expect(fixture.trace.at(-1)).toEqual({ step, phase });
    expect(fixture.trace).toEqual(mcpSteps.slice(0, mcpSteps.findIndex(value => value.step === step) + 1));
    expect(fixture.checks).toEqual(step === "secretObservation" ? ["nativeMcp"] : []);
  });
});

describe("native qualification steps", () => {
  it("uses unique values a model will repeat verbatim", () => {
    const values = new Set(Array.from({ length: 200 }, () => qualificationPhrase()));
    expect(values.size).toBe(200);
    for (const value of values) {
      // A prefix plus hex reads as a credential, which providers may withhold;
      // the replay checks must depend on the redactor, not on model policy.
      expect(value).toMatch(/^[a-z]+(?:-[a-z]+){5}-[0-9]{1,5}$/);
      expect(value).not.toMatch(/secret|token|key|password|synthetic|credential/i);
      expect(value.length).toBeGreaterThanOrEqual(24);
    }
  });
  it("takes a fork destination's binding from its stream or, for Codex and Cursor, its start", () => {
    const source = { providerId: "cursor", resumeId: "source" }, started = { providerId: "cursor", resumeId: "fresh" };
    expect(forkDestinationBinding(undefined, started)).toBe(started);
    const streamed = { providerId: "claude", resumeId: "streamed" };
    expect(forkDestinationBinding(streamed, { providerId: "claude", resumeId: "provisional" })).toBe(streamed);
    expect(forkDestinationBinding(undefined, undefined)).toBeUndefined();
    expect(forkDestinationBinding(undefined, started)?.resumeId).not.toBe(source.resumeId);
  });
});

describe("raw secret observation", () => {
  const chunk = (text: string) => ({ sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  it("observes a secret streamed across message chunks, once per turn", () => {
    const phrase = "amber-harbor-velvet-copper-meadow-ivory-4821", observer = rawSecretObserver(phrase);
    // Providers stream replies token by token, so no single chunk holds the value.
    expect(["The result was: amber-har", "bor-velvet-copper-mea", "dow-ivory-4821", " again amber-harbor-velvet-copper-meadow-ivory-4821"].map(text => observer.observe(chunk(text))))
      .toEqual([false, false, true, false]);
    observer.reset();
    expect(observer.observe(chunk(phrase))).toBe(true);
  });
  it("observes a complete value in any other notification", () => {
    const phrase = "cedar-lagoon-willow-raven-mint-sage-7", observer = rawSecretObserver(phrase);
    expect(observer.observe({ update: { sessionUpdate: "tool_call_update", rawOutput: `probe\n${phrase}` } })).toBe(true);
    expect(observer.observe({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cedar-lagoon" } } })).toBe(false);
  });
});

describe("failure signature", () => {
  it("keeps only fixed-format error codes and class names", () => {
    const erofs = Object.assign(new Error("EROFS: read-only file system, open '/srv/zeros/home/agent/.codex/x'"), { code: "EROFS" });
    expect(failureSignature(erofs)).toMatchObject({ code: "EROFS", name: "Error" });
    expect(failureSignature(Object.assign(new TypeError("private text"), { cause: { code: "ERR_STREAM_PREMATURE_CLOSE" } })))
      .toMatchObject({ code: "ERR_STREAM_PREMATURE_CLOSE", name: "TypeError" });
    // Free text, lowercase or oversized values never pass through.
    const rejected = failureSignature(Object.assign(new Error("x"), { code: "sk-live secret value", name: "Error: with a message" }));
    expect(rejected).not.toHaveProperty("code"); expect(rejected).not.toHaveProperty("name");
    expect(failureSignature("a string")).toEqual({});
  });
});

describe("failure classification", () => {
  it("retains the fixed identifiers from an actual Node assertion", () => {
    const error = new assert.AssertionError({ message: "synthetic assertion failure", actual: false, expected: true, operator: "strictEqual" });
    expect(failureSignature(error)).toMatchObject({ name: "AssertionError", code: "ERR_ASSERTION" });
  });
  it("retains only actual engine failure kinds and stages, including camel-cased stages", () => {
    for (const stage of ["initialize", "newSession", "loadSession", "forkSession", "prompt", "cancel", "stopBackgroundTask", "setMode"]) {
      const error = Object.assign(new Error("synthetic engine failure"), { failure: { kind: "transport-closed", stage } });
      expect(failureSignature(error)).toMatchObject({ kind: "transport-closed", stage });
    }
  });
  it("rejects unknown pattern-shaped labels and can retain a known code from the bounded cause chain", () => {
    const invalid = failureSignature(Object.assign(new Error("synthetic failure"), {
      code: "PRIVATE_CREDENTIAL_CODE", name: "PrivateCredentialError", failure: { kind: "private-token", stage: "private-path" },
    }));
    for (const field of ["code", "name", "kind", "stage"]) expect(invalid).not.toHaveProperty(field);
    expect(failureSignature(Object.assign(new Error("synthetic error"), { code: "PRIVATE_CREDENTIAL_CODE", cause: { code: "EROFS" } })))
      .toMatchObject({ code: "EROFS" });
  });
  it("keeps an agent failure's fixed kind, stage and exit code", () => {
    const error = Object.assign(new Error("codex app-server exited before initialize"), {
      kind: "subprocess-exited", stage: "initialize", failure: { kind: "subprocess-exited", stage: "initialize", message: "private", exit: { code: 101, stderrTail: "private" } } });
    expect(failureSignature(error)).toMatchObject({ name: "Error", kind: "subprocess-exited", stage: "initialize", exitCode: 101 });
    const invalid = failureSignature(Object.assign(new Error("x"), { failure: { kind: "Has Spaces", stage: "x".repeat(80), exit: { code: "1; rm" } } }));
    for (const key of ["kind", "stage", "exitCode"]) expect(invalid).not.toHaveProperty(key);
  });
});

describe("failure message digest", () => {
  it("identifies an engine message by a truncated digest, never by its text", async () => {
    const { createHash } = await import("node:crypto");
    const message = "Cloud Codex requires the pinned native executable";
    const signature = failureSignature(new Error(message));
    expect(signature.messageSha256).toBe(createHash("sha256").update(message).digest("hex").slice(0, 16));
    expect(JSON.stringify(signature)).not.toContain("pinned");
    expect(failureSignature(new Error("x".repeat(600))).messageSha256).toBeUndefined();
  });
});
