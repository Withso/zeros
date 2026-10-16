import { constants } from "node:fs";
import { mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { soakMain } from "../zeros-dev/soak-cli";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zd-soak-cli-")); roots.push(root);
  const file = path.join(root, "soak.json"), key = createCloudReplicaDeviceCredential(randomUUID()).publicKey, output: unknown[] = [];
  const argv = ["--end", "2026-10-14T00:00:00Z", "--device-id", randomUUID(), "--public-key", key, "--output", file];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.method).toBe("GET"); return Response.json({ total_count: 0, workflow_runs: [] });
  });
  return { root, file, argv, output, fetcher, options: { env: { GITHUB_TOKEN: "synthetic-readonly" }, fetch: fetcher,
    now: () => Date.parse("2026-10-14T01:00:00Z"), write: (value: unknown) => { output.push(value); } } };
}
describe("soak collector CLI read and output boundary", () => {
  it("labels an explicitly requested infrastructure report with its owner §7 exclusions", async () => {
    const f = await fixture();
    expect(await soakMain([...f.argv, "--profile", "infrastructure"], f.options)).toBe(1);
    expect(f.fetcher).toHaveBeenCalledOnce();
    const file = await open(f.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { expect(JSON.parse(await file.readFile("utf8"))).toMatchObject({ schema: "zeros.dev-infrastructure-soak/v1",
      coverage: { agents: "not_covered_owner_section7" }, status: "incomplete" }); } finally { await file.close(); }
    expect(f.output).toContainEqual(expect.objectContaining({ schema: "zeros.dev-infrastructure-soak-result/v1", status: "incomplete" }));
  });
  it("writes one private report and closed summary with no credential value or fixture access", async () => {
    const f = await fixture(); expect(await soakMain(f.argv, f.options)).toBe(1);
    const input = await open(f.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      expect((await input.stat()).mode & 0o7777).toBe(0o600);
      const text = await input.readFile("utf8"), report = JSON.parse(text);
      expect(report.slots).toHaveLength(24); expect(report.status).toBe("incomplete");
      expect(text).not.toContain("synthetic-readonly"); expect(JSON.stringify(f.output)).not.toContain("synthetic-readonly");
    } finally { await input.close(); }
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(String(f.fetcher.mock.calls[0]![0])).toMatch(/^https:\/\/api\.github\.com\/repos\/Withso\/zeros\/actions\/workflows\//);
  });
  it("refuses existing output and symlinks before any request", async () => {
    const f = await fixture(), target = path.join(f.root, "original"); await writeFile(target, "owned", { mode: 0o600 });
    await symlink(target, f.file);
    expect(await soakMain(f.argv, f.options)).toBe(1); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.output).toContainEqual(expect.objectContaining({ code: "artifact_invalid" }));
    const input = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { expect(await input.readFile("utf8")).toBe("owned"); } finally { await input.close(); }
  });
  it("keeps a raw API failure out of both the summary and the incomplete pack", async () => {
    const f = await fixture(); f.fetcher.mockRejectedValue(new Error("synthetic-private-provider-response"));
    expect(await soakMain(f.argv, f.options)).toBe(1);
    const input = await open(f.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const text = await input.readFile("utf8"); expect(text).not.toContain("synthetic-private-provider-response");
      expect(JSON.parse(text).collection).toBe("unavailable");
    } finally { await input.close(); }
  });
  it.each(["argument", "key"])("classifies malformed %s before any Actions read", async kind => {
    const f = await fixture();
    if (kind === "argument") f.argv.push("--unknown"); else f.argv[f.argv.indexOf("--public-key") + 1] = "invalid";
    expect(await soakMain(f.argv, f.options)).toBe(1);
    expect(f.output).toContainEqual(expect.objectContaining({ code: "invalid_request" }));
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("accepts a canonical public key whose base64url encoding starts with a dash", async () => {
    const f = await fixture();
    f.argv[f.argv.indexOf("--public-key") + 1] = Buffer.alloc(32, 0xf8).toString("base64url");
    expect(await soakMain(f.argv, f.options)).toBe(1);
    expect(f.output).toContainEqual(expect.objectContaining({ status: "incomplete", collection: "complete", completeHours: 0 }));
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("refuses a replaced output and never deletes the replacement on failure", async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async () => {
      await rename(f.file, path.join(f.root, "original-output"));
      await writeFile(f.file, "another owned output", { mode: 0o600, flag: "wx" });
      return Response.json({ total_count: 0, workflow_runs: [] });
    });
    expect(await soakMain(f.argv, f.options)).toBe(1);
    expect(f.output).toContainEqual(expect.objectContaining({ code: "artifact_invalid" }));
    const input = await open(f.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { expect(await input.readFile("utf8")).toBe("another owned output"); } finally { await input.close(); }
  });
});
