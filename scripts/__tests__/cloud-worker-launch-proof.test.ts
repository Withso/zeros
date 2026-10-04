import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { activePath, attestationFixture, proofPath } from "./cloud-worker-attestation-fixture";

const fixtures: ReturnType<typeof attestationFixture>[] = [];
function fixture() {
  const tree = attestationFixture(); fixtures.push(tree);
  expect(tree.execute().exitCode).toBe(0);
  return tree;
}
afterEach(() => { for (const tree of fixtures.splice(0)) tree.dispose(); });
function consume(tree: ReturnType<typeof fixture>, ok: boolean, check = "launch_proof") {
  const result = tree.execute("consume-cloud-admission.mjs");
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(ok ? 0 : 1);
  expect(JSON.parse(result.stdout)).toEqual({ schema: "zeros.diagnostic/v1", component: "attester", stage: "consume_proof",
    ok, exitCode: ok ? 0 : 1, timedOut: false, failedChecks: ok ? [] : [check] });
  expect(fs.existsSync(tree.physical(proofPath))).toBe(false);
  expect(fs.readdirSync(tree.physical("/run/zeros")).filter(name => name.endsWith(".consumed"))).toEqual([]);
}

describe("v4 one-use launch proof", () => {
  it("consumes exactly once without a legacy image build", () => {
    const tree = fixture();
    consume(tree, true);
    consume(tree, false);
  });
  it.each([
    ["runtimeId", `r1-${"f".repeat(64)}`], ["manifestSha256", "f".repeat(64)],
    ["baseCompatibilityId", `bc1-${"f".repeat(64)}`], ["installerReceiptSha256", "f".repeat(64)],
    ["bootId", "32345678-1234-4234-8234-123456789abc"], ["supervisorSessionId", "32345678-1234-4234-8234-123456789abc"],
    ["profile", "zeros-cloud-worker-v3"], ["version", 1], ["reportSha256", "invalid"],
    ["containerInitStartTicks", "67890"], ["qualifiedAtMs", 0], ["unexpected", true],
  ])("burns a proof with mismatched %s", (field, value) => {
    const tree = fixture();
    tree.write(proofPath, { ...JSON.parse(fs.readFileSync(tree.physical(proofPath), "utf8")), [field]: value }, 0o400);
    consume(tree, false);
    consume(tree, false);
  });
  it.each(["mnt", "pid", "cgroup"])("retains %s namespace binding", name => {
    const tree = fixture(); tree.namespaces[name] = `${name}:[999]`;
    consume(tree, false);
  });
  it.each([5 * 60_000 + 1, -5001])("rejects a stale or future proof at clock delta %i", delta => {
    const tree = fixture(); tree.advance(delta);
    consume(tree, false);
  });
  it("rejects a fresh supervisor session even in the same boot", () => {
    const tree = fixture();
    tree.write(activePath, { ...tree.descriptor, supervisorSessionId: "32345678-1234-4234-8234-123456789abc" }, 0o600);
    consume(tree, false);
  });
  it("burns a proof when installation identity has changed after qualification", () => {
    const tree = fixture(); tree.write(tree.receiptPath, "{}", 0o600);
    consume(tree, false, "receipt_digest");
  });
  it.each(["owner", "mode", "hardlink", "symlink"])("rejects unsafe proof %s", kind => {
    const tree = fixture();
    if (kind === "owner") tree.owners.set("/run/zeros/.cloud-worker-admission.42.consumed", 10001);
    if (kind === "mode") fs.chmodSync(tree.physical(proofPath), 0o644);
    if (kind === "hardlink") fs.linkSync(tree.physical(proofPath), tree.physical("/run/zeros/alias"));
    if (kind === "symlink") {
      fs.renameSync(tree.physical(proofPath), tree.physical("/run/zeros/alias"));
      tree.link(proofPath, "alias");
    }
    consume(tree, false, kind === "mode" ? "file_mode" : kind === "hardlink" ? "hard_link" : "root_ownership");
  });
});
