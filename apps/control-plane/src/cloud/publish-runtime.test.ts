import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(version = 1) {
  const directory = await mkdtemp(join(tmpdir(), "publish-runtime-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const dist = join(directory, "dist");
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const file of ["worker.mjs", "cursor-host.mjs", "git-askpass.mjs", "gh.mjs", "bin/gh", "bin/git-askpass"]) {
    const content = Buffer.from(`fixture ${file}`);
    await mkdir(dirname(join(dist, file)), { recursive: true });
    await writeFile(join(dist, file), content);
    files[file] = { sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length };
  }
  const native = ["@openai/codex-linux-x64", "@anthropic-ai/claude-agent-sdk-linux-x64", "@cursor/sdk-linux-x64"];
  await writeFile(join(dist, "runtime-manifest.json"), JSON.stringify({ version: 1, node: "24", platform: "linux", arch: "x64",
    packages: Object.fromEntries(native.map(name => [name, { name, version: "1.0.0" }])), files }));
  await writeFile(join(dist, "BUILD.json"), JSON.stringify({ commit: "a".repeat(40) }));
  const archive = join(directory, "runtime.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", dist, "."]);
  const contents = await readFile(archive);
  const sha256 = createHash("sha256").update(contents).digest("hex");

  const requests: { method: string; path: string; authorization: string; body: Buffer }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ method: request.method!, path: request.url!, authorization: request.headers.authorization ?? "", body: Buffer.concat(chunks) });
    response.writeHead(request.method === "HEAD" ? 404 : 200).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback storage server");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const storage = { endpoint, bucket: "fixture-local", accessKeyId: "fixture-local-access", secretAccessKey: "fixture-local-secret" };
  const profile = join(directory, "profile.json");
  await writeFile(profile, JSON.stringify({ version, storage, railway: { token: "fixture-unrelated-secret" } }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ZEROS_DEV_PROFILE_PATH: profile,
    CLOUD_V2_RUNTIME_STORE_ENDPOINT: endpoint,
    CLOUD_V2_RUNTIME_STORE_BUCKET: "fixture-hosted",
    CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID: "fixture-hosted-access",
    CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY: "fixture-hosted-secret",
  };
  const publish = (...args: string[]) => run(process.execPath, ["--import", "tsx", "src/cloud/publish-runtime.ts", "--artifact", archive, ...args], {
    cwd: resolve(import.meta.dirname, "../.."), env, timeout: 15_000,
  });
  return { archive, contents, env, profile, publish, requests, sha256, storage };
}

it.each([1, 2])("publishes --local with the version %i profile's storage, without exposing credentials", async version => {
  const test = await fixture(version);
  const { stdout, stderr } = await test.publish("--local");
  expect(test.requests.map(request => request.method)).toEqual(["HEAD", "PUT"]);
  for (const request of test.requests) {
    expect(request.path.split("?")[0]).toBe(`/fixture-local/cloud-v2/runtime/${test.sha256}.tar.gz`);
    expect(request.authorization).toContain("Credential=fixture-local-access/");
  }
  expect(test.requests[1]!.body.includes(test.contents)).toBe(true);
  expect(stdout).toContain(`CLOUD_V2_RUNTIME_SHA256=${test.sha256}`);
  expect(stderr).toBe("");
  for (const secret of [test.storage.accessKeyId, test.storage.secretAccessKey, "fixture-unrelated-secret", "fixture-hosted-secret"])
    expect(stdout + stderr).not.toContain(secret);
});

it("keeps environment-based publishing when --local is absent", async () => {
  const test = await fixture();
  const { stdout } = await test.publish();
  expect(test.requests).toHaveLength(2);
  expect(test.requests[1]!.path.split("?")[0]).toBe(`/fixture-hosted/cloud-v2/runtime/${test.sha256}.tar.gz`);
  expect(test.requests[1]!.authorization).toContain("Credential=fixture-hosted-access/");
  expect(stdout).toContain(`CLOUD_V2_RUNTIME_SHA256=${test.sha256}`);
});

it("publishes --local with no CLOUD_V2_RUNTIME_STORE_* environment variables", async () => {
  const test = await fixture();
  for (const key of Object.keys(test.env)) if (key.startsWith("CLOUD_V2_RUNTIME_STORE_")) delete test.env[key];
  const { stdout } = await test.publish("--local");
  expect(test.requests).toHaveLength(2);
  expect(test.requests[1]!.path.split("?")[0]).toBe(`/fixture-local/cloud-v2/runtime/${test.sha256}.tar.gz`);
  expect(stdout).toContain(`CLOUD_V2_RUNTIME_SHA256=${test.sha256}`);
});

it.each(["incomplete", "malformed"])("refuses a %s local profile without using ambient storage or disclosing its contents", async kind => {
  const test = await fixture();
  await writeFile(test.profile, kind === "malformed" ? 'invalid "fixture-local-secret"' :
    JSON.stringify({ version: 1, storage: { ...test.storage, secretAccessKey: "" } }));
  const result = await test.publish("--local").catch(error => error);
  expect(result.code).toBe(1);
  expect(result.stdout).not.toContain("CLOUD_V2_RUNTIME_SHA256=");
  expect(result.stderr).toContain("Runtime publication failed");
  expect(result.stdout + result.stderr).not.toContain("fixture-local-secret");
  expect(test.requests).toEqual([]);
});
