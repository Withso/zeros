import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  TEMPLATES,
  fillTemplate,
  main,
  type BoatRequest,
  type KitDeps,
} from "../cloud-workspace-validation/boat-image/boat-image";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const NOW = Date.parse("2026-09-25T10:00:00Z");
const ORG = "team_00000000-0000-4000-8000-000000000000";
const CONTRACT = "c".repeat(64);
const BUILD = "b".repeat(64);
const HEX = "0123456789abcdef0123456789abcdef";
const hasPython = spawnSync("python3", ["--version"]).status === 0;

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

function repository() {
  const root = temp("boat-kit-repo-");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Kit", "-c", "user.email=kit@example.com", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "engine.ts"), "export const engine = 1;\n");
  fs.writeFileSync(path.join(root, "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  return { root, commit: git("rev-parse", "HEAD") };
}

type Call = { method: string; path: string; body?: any; headers?: Record<string, string> };

/** A fake Boat account; `replies` answers by "METHOD /path" before the defaults. */
function boat(replies: Record<string, (call: Call) => { status: number; body?: unknown }> = {}) {
  const calls: Call[] = [];
  const request: BoatRequest = async (method, apiPath, options = {}) => {
    const call = { method, path: apiPath, body: options.body, headers: options.headers };
    calls.push(call);
    const custom = replies[`${method} ${apiPath}`];
    if (custom) {
      const reply = custom(call);
      return { status: reply.status, body: reply.body ?? null };
    }
    if (method === "GET" && apiPath.startsWith("/limits")) return { status: 200, body: { creditUsedSeconds: 3600 } };
    if (method === "POST" && apiPath === "/sandboxes") return { status: 202, body: { sandbox: { id: "bx_builder1", state: "provisioning", team: { id: ORG } } } };
    if (method === "DELETE") return { status: 202, body: { operation: { id: "bdop_1" } } };
    throw new Error(`unexpected ${method} ${apiPath}`);
  };
  return { calls, request };
}

function kit(root: string, request: BoatRequest): KitDeps {
  return {
    boat: request,
    billingOrg: ORG,
    stateDir: temp("boat-kit-state-"),
    repoRoot: root,
    imageContract: () => CONTRACT,
    now: () => NOW,
    randomHex: () => HEX,
    randomUUID: () => "11111111-2222-4333-8444-555555555555",
  };
}

/** Commands answered by the fake builder, keyed by the script's first distinctive text. */
function builderScripts(outputs: { attestation?: unknown; buildHash?: unknown; sanitation?: unknown }) {
  return {
    "POST /sandboxes/bx_builder1/commands": ({ body }: Call) => {
      const command = String(body.command);
      const stdout = command.includes("native-attest.exit")
        ? outputs.attestation
        : command.includes("image-build.json').read_bytes();d=json.loads(b)")
          ? outputs.buildHash
          : command.includes("staleAdmissionRemoved")
            ? outputs.sanitation
            : undefined;
      if (stdout === undefined) return { status: 200, body: { exitCode: 1, stderr: "unexpected script" } };
      return { status: 200, body: { exitCode: 0, timedOut: false, stdoutTruncated: false, stdout: JSON.stringify(stdout) } };
    },
  };
}

async function prepared(overrides: Record<string, (call: Call) => { status: number; body?: unknown }> = {}) {
  const { root, commit } = repository();
  const attestation = {
    qualified: true,
    setupQualification: { secure: true },
    metadata: { buildSha256: BUILD, build: { source: { commit } } },
    resources: { allocation: { storageBytes: 70_000 * 1048576 } },
  };
  const fake = boat({
    ...builderScripts({
      attestation: { exit: { code: 0, retirement: 0, scopePresent: false }, report: JSON.stringify(attestation), error: "" },
      buildHash: { buildSha256: BUILD, commit, contract: CONTRACT, profile: "zeros-cloud-worker-v3" },
      sanitation: { qualified: true, sourceCommit: commit, buildSha256: BUILD, observedAt: new Date(NOW - 5_000).toISOString() },
    }),
    ...overrides,
  });
  const deps = kit(root, fake.request);
  await main(["builder", "create", "--from", "zeros-qualification-aa11196c97a6", "--max-used-hours", "9"], deps);
  await main(["export"], deps);
  await main(["generate", "--previous", "a".repeat(40)], deps);
  return { root, commit, deps, fake, dir: path.join(deps.stateDir, commit.slice(0, 12)) };
}

/** The Python program a generated script feeds to `python3 -` through its heredoc. */
function heredocBody(script: string) {
  const match = /<<'(PY|PYREMOTE)'\n([\s\S]*)\n\1\n?$/.exec(script);
  if (!match) throw new Error("no heredoc");
  return match[2];
}

describe("Boat image kit", () => {
  it("reproduces the build script of the qualified aa11196 image", () => {
    const script = fillTemplate("build.sh", {
      SOURCE_COMMIT: "aa11196c97a69ec4d1ef430dc1c6d0b36256f41d",
      IMAGE_CONTRACT_SHA256: "4b8ae9a31462b29cd502d3a0274edea1daf0058d758e3ab19ede1d2f32d8e2ed",
    });
    expect(sha256(script)).toBe("97e5b3b21438e85e53a22e2aec2d38436751c4efcb22aafa1f67ede3e336ddd9");
  });

  it("keeps templates free of build identities and private paths", () => {
    for (const name of fs.readdirSync(TEMPLATES)) {
      const text = fs.readFileSync(path.join(TEMPLATES, name), "utf8");
      expect(text, name).not.toMatch(/[a-f0-9]{32}/);
      expect(text, name).not.toMatch(/\b(bx|team)_[a-z0-9]/);
      expect(text, name).not.toMatch(/vercel-sandbox|\.context\/|\/Users\//);
    }
    expect(() => fillTemplate("attest.sh", { ATTEMPT_HEX: HEX })).toThrow("unfilled placeholder {{SOURCE_COMMIT}}");
  });

  it("exports the exact commit with a minimal git directory", async () => {
    const { root, commit } = repository();
    const deps = kit(root, boat().request);
    const report = (await main(["export"], deps)) as { archiveSha256: string; parts: number; sourceFiles: number; dir: string };
    const archive = path.join(report.dir, "source.tar.gz");
    expect(sha256(fs.readFileSync(archive))).toBe(report.archiveSha256);
    expect(fs.statSync(archive).mode & 0o777).toBe(0o600);
    expect(report).toMatchObject({ commit, parent: commit, parts: 1, exactMergedCommit: true });
    const extracted = temp("boat-kit-extract-");
    execFileSync("tar", ["-xzf", archive, "-C", extracted]);
    const git = (...args: string[]) => execFileSync("git", ["-C", extracted, ...args], { encoding: "utf8" }).trim();
    expect(git("rev-parse", "HEAD")).toBe(commit);
    expect(git("status", "--porcelain")).toBe("");
    expect(fs.statSync(path.join(extracted, "run.sh")).mode & 0o111).not.toBe(0);
    await expect(main(["export"], deps)).rejects.toThrow("already exported");
  });

  it("refuses a checkout that is not clean", async () => {
    const { root } = repository();
    fs.writeFileSync(path.join(root, "src", "engine.ts"), "changed\n");
    await expect(main(["export"], kit(root, boat().request))).rejects.toThrow("must be clean");
  });

  it("generates builder scripts bound to one attempt, commit and contract", async () => {
    const { commit, dir } = await prepared();
    const generation = JSON.parse(fs.readFileSync(path.join(dir, "generation.json"), "utf8"));
    expect(generation).toMatchObject({ commit, contract: CONTRACT, attempt: `m2-build-${HEX}`, snapshotName: `zeros-qualification-${commit.slice(0, 12)}` });
    const install = fs.readFileSync(path.join(dir, "install.sh"), "utf8");
    const scriptLine = install.split("\n").find((line) => line.startsWith("script="))!;
    const script = JSON.parse(scriptLine.slice("script=".length));
    expect(sha256(script)).toBe(generation.scriptSha256);
    expect(script).toContain(`https://github.com/withso/zeros ${commit} /opt/zeros ${CONTRACT}`);
    const runner = JSON.parse(install.split("\n").find((line) => line.startsWith("runner="))!.slice("runner=".length));
    expect(runner).toBe(fs.readFileSync(path.join(TEMPLATES, "owned-runner.py"), "utf8"));
    for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".sh"))) {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      expect(text, name).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
      expect(fs.statSync(path.join(dir, name)).mode & 0o777, name).toBe(0o600);
      execFileSync("bash", ["-n", path.join(dir, name)]);
    }
  });

  it.skipIf(!hasPython)("generates Python that compiles", async () => {
    const { dir } = await prepared();
    for (const name of ["install.sh", "builder-preflight.sh", "build-status.sh", "attest.sh", "attest-status.sh", "private-state.sh"]) {
      const program = heredocBody(fs.readFileSync(path.join(dir, name), "utf8"));
      const compiled = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), 'script', 'exec')"], { input: program, encoding: "utf8" });
      expect(compiled.status, `${name}: ${compiled.stderr}`).toBe(0);
    }
  });

  it("requires a meter limit and refuses to start at or over it", async () => {
    const { root } = repository();
    const fake = boat({ "GET /limits?org=team_00000000-0000-4000-8000-000000000000": () => ({ status: 200, body: { creditUsedSeconds: 9 * 3600 } }) });
    const deps = kit(root, fake.request);
    await expect(main(["builder", "create", "--from", "zeros-qualification-aa11196c97a6"], deps)).rejects.toThrow("--max-used-hours");
    await expect(main(["builder", "create", "--from", "zeros-qualification-aa11196c97a6", "--max-used-hours", "9"], deps)).rejects.toThrow("9.00 h, at or over --max-used-hours 9");
    expect(fake.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("replays a create whose response was lost with the same idempotency key", async () => {
    const { root } = repository();
    let attempts = 0;
    const fake = boat({
      "POST /sandboxes": () => {
        attempts += 1;
        if (attempts === 1) throw new Error("timeout");
        return { status: 202, body: { sandbox: { id: "bx_builder1", state: "provisioning", team: { id: ORG } } } };
      },
    });
    const deps = kit(root, fake.request);
    const args = ["builder", "create", "--from", "zeros-qualification-aa11196c97a6", "--max-used-hours", "9"];
    await expect(main(args, deps)).rejects.toThrow("outcome is unknown");
    await expect(main(args, deps)).resolves.toMatchObject({ id: "bx_builder1" });
    const creates = fake.calls.filter((call) => call.path === "/sandboxes");
    expect(creates).toHaveLength(2);
    for (const call of creates) {
      expect(call.headers).toEqual({ "idempotency-key": "11111111-2222-4333-8444-555555555555", "x-boat-org": ORG });
      expect(call.body).toEqual({ type: "default", from: "zeros-qualification-aa11196c97a6", ttlSeconds: 3600, noEnv: true, env: {} });
    }
    expect(fs.existsSync(path.join(deps.stateDir, "builder-intent.json"))).toBe(false);
  });

  it("forgets a create Boat definitely refused, and never replays one past the idempotency window", async () => {
    const { root } = repository();
    const fake = boat({ "POST /sandboxes": ({ body }) => (body.from === "missing-snapshot" ? { status: 404, body: { code: "snapshot_not_found" } } : { status: 503 }) });
    const deps = kit(root, fake.request);
    await expect(main(["builder", "create", "--from", "missing-snapshot", "--max-used-hours", "9"], deps)).rejects.toThrow("HTTP 404, snapshot_not_found");
    expect(fs.existsSync(path.join(deps.stateDir, "builder-intent.json"))).toBe(false);
    const args = ["builder", "create", "--from", "zeros-qualification-aa11196c97a6", "--max-used-hours", "9"];
    await expect(main(args, deps)).rejects.toThrow("HTTP 503");
    expect(fs.existsSync(path.join(deps.stateDir, "builder-intent.json"))).toBe(true);
    const creates = fake.calls.length;
    await expect(main(args, { ...deps, now: () => NOW + 23 * 3600_000 })).rejects.toThrow("too old to replay safely");
    expect(fake.calls.slice(creates).some((call) => call.method === "POST")).toBe(false);
  });

  it("reads back a wallet the create response did not confirm", async () => {
    const { root } = repository();
    const fake = boat({
      "POST /sandboxes": () => ({ status: 202, body: { sandbox: { id: "bx_builder1", state: "provisioning" } } }),
      "GET /sandboxes/bx_builder1": () => ({ status: 200, body: { sandbox: { id: "bx_builder1", state: "ready", team: { id: ORG } } } }),
    });
    await expect(main(["builder", "create", "--from", "zeros-qualification-aa11196c97a6", "--max-used-hours", "9"], kit(root, fake.request)))
      .resolves.toMatchObject({ id: "bx_builder1", state: "ready" });
  });

  it("keeps a builder billed to another wallet recorded so it can be deleted", async () => {
    const { root } = repository();
    const fake = boat({ "POST /sandboxes": () => ({ status: 202, body: { sandbox: { id: "bx_builder1", team: null } } }) });
    const deps = kit(root, fake.request);
    await expect(main(["builder", "create", "--from", "zeros-qualification-aa11196c97a6", "--max-used-hours", "9"], deps)).rejects.toThrow("not billed to BOAT_BILLING_ORG");
    await expect(main(["builder", "delete"], deps)).resolves.toMatchObject({ id: "bx_builder1", deleted: true });
    expect(fake.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/sandboxes/bx_builder1", headers: { "x-ascii-confirm-delete": "bx_builder1" } });
    await expect(main(["builder", "status"], deps)).rejects.toThrow("No builder recorded");
  });

  it("uploads the verified archive in 1 MiB parts", async () => {
    const { deps, fake } = await prepared({
      "PUT /sandboxes/bx_builder1/files": ({ body }) => ({ status: 200, body: { size: Buffer.from(body.content, "base64").length } }),
    });
    await expect(main(["builder", "upload"], deps)).resolves.toMatchObject({ uploaded: true, parts: 1 });
    expect(fake.calls.filter((call) => call.method === "PUT").map((call) => call.body.path)).toEqual(["/tmp/zeros-runtime-source.part-0"]);
  });

  it("refuses to run an unfilled template on the builder", async () => {
    const { deps, fake } = await prepared();
    await expect(main(["builder", "run", path.join(TEMPLATES, "sanitize.sh")], deps)).rejects.toThrow("unfilled template");
    expect(fake.calls.some((call) => call.path.endsWith("/commands"))).toBe(false);
  });

  it("saves the snapshot only after attestation and fresh sanitation, then reports the Railway values", async () => {
    const saves: Call[] = [];
    const { commit, deps, dir } = await prepared({
      "GET /named-snapshots": () => ({ status: 200, body: { snapshots: [{ name: "zeros-qualification-aa11196c97a6" }] } }),
      "POST /named-snapshots": (call) => {
        saves.push(call);
        return { status: 202, body: { snapshot: { name: call.body.name, sourceSandboxId: call.body.sandboxId, status: "saving" } } };
      },
    });
    const name = `zeros-qualification-${commit.slice(0, 12)}`;
    await expect(main(["snapshot", "save"], deps)).rejects.toThrow("Run generate-post first");
    await expect(main(["generate-post"], deps)).rejects.toThrow("Run `attestation status`");
    await expect(main(["attestation", "status"], deps)).resolves.toMatchObject({ finished: true, qualified: true, matchesCommit: true, buildSha256: BUILD, measuredStorageMiB: 70_000 });
    await expect(main(["generate-post"], deps)).resolves.toMatchObject({ buildSha256: BUILD });
    expect(fs.readFileSync(path.join(dir, "sanitize.sh"), "utf8")).toContain(`buildHash=='${BUILD}'`);
    await expect(main(["snapshot", "save"], deps)).resolves.toEqual({ requested: true, name, state: "saving" });
    expect(saves.map((call) => call.body)).toEqual([{ sandboxId: "bx_builder1", name }]);
    await expect(main(["snapshot", "save"], deps)).rejects.toThrow("already requested");
    await expect(main(["builder", "delete"], deps)).rejects.toThrow(`${name} from this builder is not ready`);

    const ready = kit(deps.repoRoot, boat({
      [`GET /named-snapshots/${name}`]: () => ({ status: 200, body: { snapshot: { name, sourceSandboxId: "bx_builder1", status: "ready", sizeBytes: 1 } } }),
    }).request);
    fs.cpSync(deps.stateDir, ready.stateDir, { recursive: true });
    await expect(main(["snapshot", "status"], ready)).resolves.toEqual({
      name,
      state: "ready",
      railway: { BOAT_SNAPSHOT_ID: name, BOAT_IMAGE_BUILD_SHA256: BUILD },
    });
    await expect(main(["builder", "delete"], ready)).resolves.toMatchObject({ id: "bx_builder1", deleted: true });
    await expect(main(["snapshot", "status"], ready)).resolves.toMatchObject({ state: "ready" });
  });

  it("refuses a stale sanitation or an unqualified attestation without saving", async () => {
    const stale = await prepared({
      "GET /named-snapshots": () => ({ status: 200, body: { snapshots: [] } }),
      "POST /named-snapshots": () => {
        throw new Error("must not save");
      },
    });
    await main(["attestation", "status"], stale.deps);
    await main(["generate-post"], stale.deps);
    const later = { ...stale.deps, now: () => NOW + 60_000 };
    await expect(main(["snapshot", "save"], later)).rejects.toThrow("Sanitation gate");
    expect(fs.existsSync(path.join(stale.dir, "snapshot-ledger.json"))).toBe(false);

    const attestation = JSON.parse(fs.readFileSync(path.join(stale.dir, "native-attestation.json"), "utf8"));
    fs.writeFileSync(path.join(stale.dir, "native-attestation.json"), JSON.stringify({ ...attestation, qualified: false }));
    await expect(main(["snapshot", "save"], stale.deps)).rejects.toThrow("Attestation gate");
  });

  it("keeps build state outside the repository", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/cloud-workspace-validation/boat-image/boat-image.ts", "builder", "status"], {
      env: { PATH: process.env.PATH, HOME: os.homedir(), ZEROS_BOAT_IMAGE_STATE_DIR: path.resolve(".context/boat-image") },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[boat-image] ZEROS_BOAT_IMAGE_STATE_DIR must be outside the repository");
  });
});
