import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromotionError } from "./contracts";
import { command as capturedCommand, type Command } from "./io";
import { migrationReceipt } from "./migration-command";

// pnpm printed "apps/cloud-worker | WARN Unsupported engine" (Node 24 wanted,
// release jobs run Node 22) on stdout ahead of the receipt, so every Alpha
// release and controlled cutover stopped at "migration plan" with no reason.
describe("release migration receipt", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs the migration CLI through a silent pnpm so workspace warnings cannot reach the receipt", async () => {
    const command = vi.fn<Command>(async (_file, _args, options) => {
      if (options?.env?.MIGRATION_VERSION_FILE) {
        await writeFile(options.env.MIGRATION_VERSION_FILE, JSON.stringify({ serverVersionNum: 180006 }));
      }
      return JSON.stringify({ mode: "plan" });
    });
    await expect(migrationReceipt(false, { NODE_ENV: "production" }, command)).resolves.toEqual({ mode: "plan" });
    expect(command).toHaveBeenCalledWith("pnpm", ["--silent", "exec", "tsx", "scripts/release/migration-cli.ts", "--plan"],
      { env: { NODE_ENV: "production" }, timeout: 50 * 60_000 });
    await migrationReceipt(true, {}, command);
    expect(command.mock.lastCall?.[1].at(-1)).toBe("--execute");
  });

  it("names output that is not a receipt instead of stopping with a generic error", async () => {
    const command = vi.fn(async () => `apps/cloud-worker | WARN Unsupported engine\n${JSON.stringify({ mode: "plan" })}`);
    const failure = await migrationReceipt(false, {}, command).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PromotionError);
    expect((failure as Error).message).toMatch(/receipt was not valid JSON/);
    expect((failure as Error).message).not.toMatch(/WARN|apps\/cloud-worker/);
  });

  it.each([
    [180006, 0, "180006", "accepted"],
    [150010, 1, "150010", "refused"],
    [null, 1, "unknown", "refused"],
    ["private-version-detail", 0, "unknown", "refused"],
    [9007199254740992, 0, "unknown", "refused"],
  ])("logs only validated version evidence across the subprocess boundary (%s)", async (version, exitCode, measured, result) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let versionFile: string | undefined;
    const command: Command = async (_file, _args, options) => {
      versionFile = options?.env?.MIGRATION_VERSION_FILE;
      return capturedCommand(process.execPath, ["-e", `
        const fs = require('node:fs');
        if (process.env.MIGRATION_VERSION_FILE) fs.writeFileSync(process.env.MIGRATION_VERSION_FILE, process.env.FIXTURE_VERSION);
        process.stderr.write('private-migration-driver-detail\\n');
        process.stdout.write(JSON.stringify({mode:'execute'}));
        process.exitCode = Number(process.env.FIXTURE_EXIT_CODE);
      `], { ...options, env: { ...options?.env,
        FIXTURE_VERSION: JSON.stringify({ serverVersionNum: version }), FIXTURE_EXIT_CODE: String(exitCode) } });
    };
    const outcome = await migrationReceipt(true, {}, command).catch((error: unknown) => error);
    expect(log).toHaveBeenCalledExactlyOnceWith(`[migrate] server_version_num=${measured} minimum=160000 ${result}`);
    if (result === "accepted") expect(outcome).toEqual({ mode: "execute" });
    else {
      expect(outcome).toBeInstanceOf(PromotionError);
      expect((outcome as Error).message).not.toMatch(/private-/);
    }
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-/);
    expect(versionFile).toBeDefined();
    await expect(access(path.dirname(versionFile!))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses execution without a version record while retaining the safe diagnostic", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const command = vi.fn(async () => JSON.stringify({ mode: "execute" }));
    await expect(migrationReceipt(true, {}, command)).rejects.toThrow("PostgreSQL version check");
    expect(log).toHaveBeenCalledExactlyOnceWith("[migrate] server_version_num=unknown minimum=160000 refused");
  });
});
