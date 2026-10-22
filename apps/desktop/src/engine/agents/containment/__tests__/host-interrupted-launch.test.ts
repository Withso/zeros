import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostExecutionBoundary } from "../host-boundary";
import { sessionsRoot } from "../../session-paths";

const roots: string[] = [];
const children: ChildProcess[] = [];

async function interruptedSupervisorFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-host-claim-"));
  roots.push(root);
  const ready = path.join(root, "claimed");
  const script = path.join(root, "host-process-supervisor.mjs");
  const supervisor = await readFile(new URL("../host-process-supervisor.mjs", import.meta.url), "utf8");
  const handoff = "renameSync(pendingPath, claimPath);";
  expect(supervisor.split(handoff)).toHaveLength(2);
  // Hold the real supervisor after its atomic claim, before domain publication.
  await writeFile(script, supervisor.replace(handoff,
    `${handoff}\nwriteFileSync(${JSON.stringify(ready)}, 'ready');\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);`));
  return { root, ready, script };
}

async function localInterruptedLaunch() {
  const f = await interruptedSupervisorFixture();
  const executionId = `local-claim-${randomUUID()}`;
  const prepared = await new HostExecutionBoundary({ supervisorScript: f.script }).prepare({
    executionId, actor: "agent-code", cwd: f.root, workspaceRoot: f.root,
  });
  const process = await prepared.spawn({ command: "/bin/bash", args: ["-c", "read -r value"], cwd: f.root, env: {} });
  if (process.child) children.push(process.child);
  await expect.poll(() => readFile(f.ready, "utf8").catch(() => "")).toBe("ready");
  const claimsRoot = path.join(sessionsRoot(), executionId, "boundary", prepared.generation, "claims");
  const entries = await readdir(claimsRoot);
  expect(entries).toHaveLength(1);
  return { prepared, process, claim: path.join(claimsRoot, entries[0]) };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Retained from the retired resident-host suite: the Local Host launch claim
// is retired only after its exact original process group is proven empty.
describe.runIf(process.platform === "linux")("Local Host interrupted launches", () => {
  it("retires the exact original claim after its process group is proven empty", async () => {
    const f = await localInterruptedLaunch();
    try {
      await f.prepared.stopAndProve();
      expect(() => process.kill(f.process.pid, 0)).toThrow();
      await expect(readFile(f.claim)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.process.stopAndProve();
    }
  });

  it.each(["token", "generation", "ownerPid", "createdAt", "extraField"] as const)(
    "preserves an interrupted claim with changed %s despite original group emptiness", async field => {
      const f = await localInterruptedLaunch();
      await f.process.stopAndProve();
      const record = JSON.parse(await readFile(f.claim, "utf8"));
      record[field] = field === "ownerPid" || field === "createdAt" ? record[field] + 1 : "foreign";
      const changed = JSON.stringify(record);
      await writeFile(f.claim, changed);
      try {
        await expect(f.prepared.stopAndProve()).rejects.toThrow();
        expect(await readFile(f.claim, "utf8")).toBe(changed);
      } finally {
        // Remove only this deliberately corrupted fixture after refusal proof.
        await rm(f.claim, { force: true });
        await f.prepared.stopAndProve();
      }
    },
  );

  it("preserves a valid claim that has no original tracked launch", async () => {
    const f = await localInterruptedLaunch();
    await f.process.stopAndProve();
    const token = randomUUID();
    const foreign = path.join(path.dirname(f.claim), `${token}.json`);
    const record = { ...JSON.parse(await readFile(f.claim, "utf8")), token };
    const bytes = JSON.stringify(record);
    await writeFile(foreign, bytes, { mode: 0o600 });
    try {
      await expect(f.prepared.stopAndProve()).rejects.toThrow();
      expect(await readFile(foreign, "utf8")).toBe(bytes);
    } finally {
      await rm(foreign, { force: true });
      await f.prepared.stopAndProve();
    }
  });

  it("preserves the exact claim when original group-emptiness proof fails", async () => {
    const f = await localInterruptedLaunch();
    const bytes = await readFile(f.claim, "utf8");
    const refusal = new Error("synthetic original group proof refusal");
    const proving = vi.spyOn(f.process, "stopAndProve").mockRejectedValue(refusal);
    try {
      await expect(f.prepared.stopAndProve()).rejects.toBe(refusal);
      expect(await readFile(f.claim, "utf8")).toBe(bytes);
    } finally {
      proving.mockRestore();
      await f.prepared.stopAndProve();
    }
  });
});
