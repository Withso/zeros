import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureControlPlane, type FixtureControlPlane } from "../cloud-workspace-validation/cloud-agent-e2e/fixture-control-plane/server";
import { CloudRuntimeRegistration, consumeCloudRuntimeEnvironment } from "../../apps/desktop/src/engine/cloud-runtime-registration";
import { CloudWorkspaceRecordRuntime } from "../../apps/desktop/src/engine/cloud-record-runtime";
import { closeZerosDb, openZerosDb, setZerosDbPathForTesting } from "../../apps/desktop/src/engine/db";
import { coerceChatRow, upsertChat } from "../../apps/desktop/src/engine/db/chats";

const fixtures: FixtureControlPlane[] = [], roots: string[] = [], registrations: CloudRuntimeRegistration[] = [];
afterEach(async () => {
  await Promise.all(registrations.splice(0).map(registration => registration.stop()));
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
  closeZerosDb(); setZerosDbPathForTesting(null);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** HTTPS with the explicit private test CA and normal hostname verification.
 * Only the test fetch adapter consumes the CA; no global TLS/env mutation. */
function trustedFetch(ca: Buffer): typeof fetch {
  return (async (input, init) => new Promise<Response>((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const request = httpsRequest(url, { ca, method: init?.method, headers: Object.fromEntries(new Headers(init?.headers).entries()), signal: init?.signal ?? undefined }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) })));
    });
    request.once("error", reject);
    request.end(typeof init?.body === "string" ? init.body : undefined);
  })) as typeof fetch;
}

async function inspectTree(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (["node_modules", "dist", "dist-engine", "dist-electron", "build", ".git", "__tests__"].includes(entry.name)) continue;
    if (/\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await inspectTree(file);
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      const text = await readFile(file, "utf8");
      if (/(?:from\s*|import\s*(?:\(\s*)?|require\s*\()\s*["'][^"']*(?:cloud-agent-e2e|fixture-control-plane)/.test(text))
        throw new Error(`Production imports fixture: ${file}`);
    }
  }
}

describe("cloud agent E2E fixture real registration composition", () => {
  it("uses verified HTTPS, the real runtime config/parser, SQLite record sync and actor admission before engine readiness", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-fixture-cp-tls-")); roots.push(root);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", path.join(root, "key.pem"),
      "-out", path.join(root, "ca.pem"), "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
    const cert = await readFile(path.join(root, "ca.pem")), key = await readFile(path.join(root, "key.pem"));
    const fixture = createFixtureControlPlane({ tls: { cert, key } }); fixtures.push(fixture);
    const attestation = { profile: "zeros-cloud-worker-v4" as const, manifestSha256: "a".repeat(64), runtimeId: `r1-${"a".repeat(64)}`,
      baseCompatibilityId: `bc1-${"b".repeat(64)}`, installerReceiptSha256: "c".repeat(64), bootId: randomUUID(), supervisorSessionId: randomUUID() };
    fixture.configureRuntime(attestation); await fixture.start();
    const env = { ZEROS_CLOUD_RUNTIME_B64: Buffer.from(JSON.stringify(fixture.runtimeConfig())).toString("base64url") };
    const config = consumeCloudRuntimeEnvironment(env)!;
    expect(env).toEqual({});
    const caFetch = trustedFetch(cert);
    setZerosDbPathForTesting(path.join(root, "zeros.db")); openZerosDb();
    const stamp = Date.now();
    upsertChat(coerceChatRow({ id: randomUUID(), folder: root, workspaceId: "local-main", agentId: "claude", model: "claude-test", title: "fixture", createdAt: stamp, updatedAt: stamp })!);
    const records = new CloudWorkspaceRecordRuntime(root, { fetch: caFetch });
    let releaseSync!: () => void, syncStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseSync = resolve; });
    const initialSync = new Promise<void>(resolve => { syncStarted = resolve; });
    const registration = new CloudRuntimeRegistration(config, { agentRuntime: attestation, fetch: caFetch,
      onAuthorityLost: () => { throw new Error("unexpected_fixture_authority_loss"); },
      onDurableRecordSync: async authority => { await records.synchronize(authority); syncStarted(); await gate; } });
    registrations.push(registration);
    const starting = registration.start();
    await initialSync;
    expect(registration.readiness()).toBeNull();
    expect(fixture.inspect()).toMatchObject({ registered: true, recordRevision: 1, recordHeadReads: 1 });
    releaseSync(); await starting;
    expect(registration.readiness()).toMatchObject({ health: "ready", durableRecordConnected: true });
    expect(await registration.verifyClientAdmission(fixture.actorGrantToken)).toMatchObject({ accountUserId: fixture.actor.userId,
      actor: { sessionId: fixture.actor.sessionId, deviceId: fixture.actor.deviceId, role: "developer" } });
    expect(await registration.verifyClientAdmission(fixture.actorGrantToken)).toBeNull();
    expect(await registration.verifyClientAdmission(fixture.actorGrantToken, true)).not.toBeNull();
  });

  it("remains outside every production app/package import graph", async () => {
    await inspectTree(path.resolve("apps")); await inspectTree(path.resolve("packages"));
  });

  it.each(["__tests__/composition.ts", "composition.test.ts"])("allows fixture composition in the test-only path %s", async file => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-fixture-test-import-")); roots.push(root);
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'import { createFixtureControlPlane } from "../scripts/cloud-agent-e2e/fixture-control-plane/server";');
    await expect(inspectTree(root)).resolves.toBeUndefined();
  });

  it.each([
    'import { createFixtureControlPlane } from "../scripts/cloud-agent-e2e/fixture-control-plane/server";',
    'import "../scripts/cloud-agent-e2e/fixture-control-plane/server";',
    'const fixture = import("../scripts/cloud-agent-e2e/fixture-control-plane/server");',
    'const fixture = require("../scripts/cloud-agent-e2e/fixture-control-plane/server");',
  ])("rejects a production fixture import: %s", async source => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-fixture-production-import-")); roots.push(root);
    const target = path.join(root, "runtime.ts");
    await writeFile(target, source);
    await expect(inspectTree(root)).rejects.toThrow(`Production imports fixture: ${target}`);
  });
});
