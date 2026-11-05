import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ApplicationEnvironment } from "../../credentials/application-environment";
import { redactDriverMessage } from "../../drivers/driver";
import { SessionStore } from "../../sessions/session-store";
import { HistoryMirror } from "../../sessions/history-mirror";
import { FakeRelay } from "../../__tests__/worker-fixtures";
import { WorkspaceSetup } from "../setup";
import { repositoryFixture } from "./repository-fixture";

const canary = 'synthetic-app-"canary"\nnext';
const variants = () => [canary, JSON.stringify(canary).slice(1, -1), encodeURIComponent(canary), Buffer.from(canary).toString("base64")];
const application = () => new ApplicationEnvironment({ variables: { APP_SECRET: canary }, files: [{ path: ".env", content: "FILE_SECRET=synthetic-file-canary\n" }] });
const privateValue = (output: string) => [...variants(), "synthetic-file-canary"].some(value => output.includes(value));

it("actual setup log writes redact split and escaped values before persistence", async () => {
  const f = await repositoryFixture();
  const setup = new WorkspaceSetup({ directory: f.state, workspace: { ...f.scope.workspace, setup: "synthetic" }, gitEnvironment: {},
    application: application(), activity() {}, runner: async (_file, _args, options) => {
      expect(options.env.APP_SECRET === canary).toBe(true);
      for (const value of [...variants(), "synthetic-file-canary"]) {
        const bytes = Buffer.from(`before ${value} after\n`);
        for (const byte of bytes) options.output(Buffer.from([byte]));
      }
      return 0;
    } });
  setup.start(true);
  try {
    await expect.poll(() => setup.busy).toBe(false);
    const log = await readFile(join(f.state, "workspace-setup", `${f.scope.workspace.id}.log`), "utf8");
    expect(privateValue(log)).toBe(false);
    expect(log.match(/before \[redacted\] after/g)).toHaveLength(5);
    expect(privateValue(await readFile(join(f.state, "workspace-setup", `${f.scope.workspace.id}.json`), "utf8"))).toBe(false);
  } finally { await setup.dispose(); }
});

it("redacts existing restored history before backfill without changing receipt identity", async () => {
  const f = await repositoryFixture(), app = application(), store = await SessionStore.open(join(f.state, "sessions"), f.scope.key);
  await store.upsert({ id: "chat", folder: f.scope.root, title: canary });
  await store.importMessages("chat", [{ msgId: "message", kind: "text", payload: JSON.stringify({ id: "message", kind: "text", role: "assistant", text: canary, timestamp: 1 }), createdAt: 1 }]);
  const relay = new FakeRelay(); relay.connected = true;
  const mirror = new HistoryMirror(store, relay, () => true, value => app.value(value));
  try {
    mirror.connect(); await mirror.flush();
    expect(privateValue(JSON.stringify(relay.frames))).toBe(false);
    expect(relay.frames.some(frame => frame.t === "history" && frame.messages?.rows.some(row => row.msgId === "message"))).toBe(true);
    expect(relay.frames.some(frame => frame.t === "history" && frame.chats?.some(chat => chat.title === "[redacted]"))).toBe(true);
  } finally { await mirror.dispose(); await store.flush(); }
});

it("short values cannot corrupt the history payload's protocol fields", async () => {
  const f = await repositoryFixture(), app = new ApplicationEnvironment({ variables: { APP_VALUE: "text" }, files: [] });
  const store = await SessionStore.open(join(f.state, "sessions"), f.scope.key);
  await store.upsert({ id: "chat", folder: f.scope.root, title: "visible" });
  await store.importMessages("chat", [{ msgId: "message", kind: "text", payload: JSON.stringify({ id: "message", kind: "text", role: "assistant", text: "text", timestamp: 1 }), createdAt: 1 }]);
  const relay = new FakeRelay(); relay.connected = true;
  const mirror = new HistoryMirror(store, relay, () => true, value => app.value(value));
  try {
    mirror.connect(); await mirror.flush();
    const row = relay.frames.flatMap(frame => frame.t === "history" ? frame.messages?.rows ?? [] : [])[0]!;
    expect(row.kind).toBe("text");
    expect(JSON.parse(row.payload)).toMatchObject({ kind: "text", text: "[redacted]" });
  } finally { await mirror.dispose(); await store.flush(); }
});

it("keeps restored question controls usable when an app value equals their input kind", async () => {
  const f = await repositoryFixture(), app = new ApplicationEnvironment({ variables: { APP_VALUE: "text" }, files: [] });
  const store = await SessionStore.open(join(f.state, "sessions"), f.scope.key);
  await store.upsert({ id: "chat", folder: f.scope.root, title: "visible" });
  await store.importMessages("chat", [{ msgId: "question", kind: "question", createdAt: 1,
    payload: JSON.stringify({ id: "question", kind: "question", source: "native_rpc", blocking: true, createdAt: 1,
      questions: [{ id: "q", prompt: "Enter text", inputType: "text", allowOther: true }] }) }]);
  const relay = new FakeRelay(); relay.connected = true;
  const mirror = new HistoryMirror(store, relay, () => true, value => app.value(value));
  try {
    mirror.connect(); await mirror.flush();
    const row = relay.frames.flatMap(frame => frame.t === "history" ? frame.messages?.rows ?? [] : [])[0]!;
    expect(JSON.parse(row.payload)).toMatchObject({ kind: "question", questions: [{ id: "q", inputType: "text", prompt: "Enter [redacted]" }] });
  } finally { await mirror.dispose(); await store.flush(); }
});

it("truncating a setup log never flushes a partial secret at its byte limit", async () => {
  const f = await repositoryFixture();
  const setup = new WorkspaceSetup({ directory: f.state, workspace: { ...f.scope.workspace, setup: "synthetic" }, gitEnvironment: {},
    application: application(), activity() {}, runner: async (_file, _args, options) => {
      options.output(Buffer.from("x".repeat(256 * 1024 - 8) + canary)); return 0;
    } });
  setup.start(true);
  try {
    await expect.poll(() => setup.busy).toBe(false);
    const log = await readFile(join(f.state, "workspace-setup", `${f.scope.workspace.id}.log`), "utf8");
    expect(log.includes(canary.slice(0, 8))).toBe(false);
    expect(log.length).toBeGreaterThan(250 * 1024);
  } finally { await setup.dispose(); }
});

it("native diagnostic text and JSON remove app and selected credential values", () => {
  const input = { sessionId: "execution", cwd: "/fixture", apiKey: "synthetic-provider-secret", application: application() };
  for (const message of [...variants(), JSON.stringify({ detail: canary, output: "synthetic-file-canary" }), "synthetic-provider-secret"]) {
    const output = redactDriverMessage(message, input);
    expect(privateValue(output) || output.includes("synthetic-provider-secret")).toBe(false);
    expect(output).toContain("[redacted]");
  }
});
