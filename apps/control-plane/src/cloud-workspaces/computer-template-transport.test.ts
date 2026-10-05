import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builderFixture, builderIntent } from "./cloud-builder-vm-test-fixtures.js";
import type { BuilderFixedCommand } from "./cloud-builder-vm.js";
import { parseBuilderDiagnostic } from "./cloud-builder-commands.js";

const helper = fileURLToPath(new URL(
  "../../../../scripts/cloud-workspace-validation/runtime-base-v4/computer-build.py", import.meta.url,
));
const canRunHelper = process.platform === "linux" && spawnSync(
  "sudo", ["-n", "/usr/bin/python3", "-I", "-c", "import os; assert os.geteuid() == 0"], { stdio: "ignore" },
).status === 0;
const job = { buildId: "11111111-1111-4111-8111-111111111111", workerFence: 1 };
const payload = (schema: string, fields: object = {}) => Buffer.from(JSON.stringify({ schema, ...job, ...fields }));
// The channel fixture replaces only SSH and host/system services. The real
// Python entrypoint reads stdin and emits both protocol lines. Polls reopen an
// identical fixture spool so cursors still drain the helper's actual batches.
const driver = `
import importlib.util, io, json, os, pathlib, sys, tempfile
spec=importlib.util.spec_from_file_location("computer_build", sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
command=sys.argv[2]
raw=sys.stdin.buffer.read()
value=json.loads(raw)
with tempfile.TemporaryDirectory(prefix="zeros-v2-test-helper-") as root:
    app=module.ComputerBuild(pathlib.Path(root))
    if command == "run-install" and value.get("action") == "poll":
        identity={key:value[key] for key in ("buildId", "workerFence")}
        store=module.InstallStore(app.job_directory(identity), identity)
        store.initialize("fixture")
        redactor=module.LogFilter(["fixture-redaction"])
        for piece in ("fixture-", "redaction\\n"):
            store.append("stdout", redactor.push("stdout", piece))
        store.append("stdout", redactor.finish("stdout"))
        store.append("stdout", ('\\\\"\\t\\n' * 16384) + ('🙂' * 8192))
        store.finish(0, False)
    module.ComputerBuild=lambda:app
    sys.argv=[sys.argv[1], command]
    sys.stdin=io.TextIOWrapper(io.BytesIO(raw))
    result=module.main()
    if command == "clone-repos" and result == 0:
        assert not app.path("/srv/zeros/files/repos").exists()
    sys.exit(result)
`;

async function fixture() {
  const boat = builderFixture();
  const vm = await boat.vms.create({ ...builderIntent, purpose: "computer-build" });
  boat.channel.execute.mockImplementation(async input => {
    const command = /^\/usr\/bin\/sudo -n \/usr\/bin\/timeout --signal=TERM --kill-after=5s [0-9]+s \/usr\/bin\/sudo -n \/usr\/bin\/python3 -I \/opt\/zeros-bootstrap\/computer-build\.py (clone-repos|run-install|verify-tcb|sanitize)$/.exec(input.command)?.[1];
    expect(command).toBeDefined();
    const result = spawnSync("sudo", ["-n", "/usr/bin/python3", "-I", "-c", driver, helper, command!], {
      input: input.stdin, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    expect(result.stderr).toBe("");
    expect(result.signal).toBeNull();
    expect(result.error).toBeUndefined();
    return { exitCode: result.status!, output: result.stdout, outputTruncated: false };
  });
  return { ...boat, vm };
}

describe.skipIf(!canRunHelper)("real builder adapter and computer helper protocol", () => {
  it("passes clone stdin to the actual helper and parses its final diagnostic", async () => {
    const boat = await fixture();
    const input = payload("zeros.computer-repositories-input/v1", { repositories: [] });
    const result = await boat.vms.runFixed(boat.vm, "computer:clone-repos", input);
    expect(JSON.parse(result.stdout.split("\n")[0]!)).toEqual({
      schema: "zeros.computer-repositories/v1", buildId: job.buildId, repositories: [],
    });
    expect(result.diagnostic).toMatchObject({ component: "build", stage: "repositories", ok: true });
    expect(boat.channel.execute.mock.calls[0]![0].stdin).toBe(input.toString());
    expect(JSON.stringify(boat.fetcher.mock.calls)).not.toContain(input.toString());
    expect(boat.channel.dispose).toHaveBeenCalledOnce();
  });

  it("drains escaped and multibyte logs through the real 64 KiB adapter limit", async () => {
    const boat = await fixture();
    const chunks: string[] = [];
    let after = 0;
    for (let page = 0; page < 32; page++) {
      const result = await boat.vms.runFixed(boat.vm, "computer:run-install",
        payload("zeros.computer-install-input/v1", { action: "poll", after }));
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(65536);
      expect(result.diagnostic).toMatchObject({ component: "build", stage: "install", ok: true });
      const value = JSON.parse(result.stdout.split("\n")[0]!);
      chunks.push(...value.chunks.map((chunk: { text: string }) => chunk.text));
      if (value.state === "succeeded") break;
      expect(value.state).toBe("running");
      expect(value.exitCode).toBeNull();
      expect(value.nextAfter).toBeGreaterThan(after);
      after = value.nextAfter;
      expect(page).toBeLessThan(31);
    }
    const text = chunks.join("");
    expect(text).toBe("[redacted]\n" + '\\"\t\n'.repeat(16384) + "🙂".repeat(8192));
    expect(text).not.toContain("fixture-redaction");
    expect(boat.channel.execute.mock.calls.length).toBeGreaterThan(1);
    expect(boat.channel.dispose).toHaveBeenCalledTimes(boat.channel.execute.mock.calls.length);
  });

  it.each([
    ["computer:clone-repos", "repositories", "input_schema"],
    ["computer:run-install", "install", "input_schema"],
    ["computer:verify-tcb", "integrity", "tcb_modified"],
    ["computer:sanitize", "sanitation", "input_schema"],
  ] as const)("parses the actual %s helper's closed failure", async (command, stage, check) => {
    const boat = await fixture();
    const result = await boat.vms.runFixed(boat.vm, command, Buffer.from("{}"));
    expect(result).toMatchObject({ exitCode: 1, diagnostic: { component: "build", stage, ok: false, failedChecks: [check] } });
    expect(boat.channel.dispose).toHaveBeenCalledOnce();
  });
});

describe("computer command input and diagnostic boundaries", () => {
  it.skipIf(process.platform !== "linux" || !process.env.CI)("requires the real helper on Linux CI", () => {
    expect(canRunHelper, "Install Python 3 and passwordless sudo for the helper contract tests").toBe(true);
  });

  it("accepts only the command's final closed diagnostic", () => {
    const diagnostic = { schema: "zeros.diagnostic/v1", component: "build", stage: "install",
      ok: false, exitCode: 1, timedOut: false, failedChecks: ["install_exit"] };
    const parse = (value: object) => parseBuilderDiagnostic(JSON.stringify(value), "computer:run-install", 1);
    expect(parse(diagnostic)).toEqual(diagnostic);
    for (const patch of [
      { component: "qualification" }, { stage: "sanitation" }, { failedChecks: ["unknown_check"] },
      { failedChecks: [] }, { exitCode: 0 }, { ok: true }, { extra: "untrusted" },
    ]) expect(parse({ ...diagnostic, ...patch })).toBeNull();
    expect(parse({ ...diagnostic, stage: "validate_input", failedChecks: ["input_schema"] })).not.toBeNull();
    expect(parseBuilderDiagnostic(`${JSON.stringify(diagnostic)}\nuntrusted`, "computer:run-install", 1)).toBeNull();
    expect(parseBuilderDiagnostic(JSON.stringify(diagnostic), "computer:arbitrary", 1)).toBeNull();
  });
  it("rejects unknown commands, missing or oversized input and qualification VMs before SSH", async () => {
    const boat = builderFixture();
    const vm = await boat.vms.create({ ...builderIntent, purpose: "computer-build" });
    const inputs: Array<[BuilderFixedCommand, Buffer | undefined]> = [
      ["computer:arbitrary", payload("zeros.computer-install-input/v1")],
      ["computer:run-install", undefined], ["computer:run-install", Buffer.alloc(0)],
      ["computer:run-install", Buffer.alloc(262145)], ["computer:run-install", Buffer.from([0xff])],
    ];
    for (const [command, input] of inputs)
      await expect(boat.vms.runFixed(vm, command, input)).rejects.toMatchObject({ check: "command_invalid" });
    const qualification = builderFixture();
    const qualificationVm = await qualification.vms.create(builderIntent);
    await expect(qualification.vms.runFixed(qualificationVm, "computer:clone-repos",
      payload("zeros.computer-repositories-input/v1", { repositories: [] }))).rejects.toMatchObject({ check: "command_invalid" });
    expect(boat.channel.execute).not.toHaveBeenCalled();
    expect(qualification.channel.execute).not.toHaveBeenCalled();
  });
});
