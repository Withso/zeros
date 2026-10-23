import { describe, expect, it, vi } from "vitest";
import { PromotionError } from "./contracts";
import { migrationReceipt } from "./migration-command";

// pnpm printed "apps/cloud-worker | WARN Unsupported engine" (Node 24 wanted,
// release jobs run Node 22) on stdout ahead of the receipt, so every Alpha
// release and controlled cutover stopped at "migration plan" with no reason.
describe("release migration receipt", () => {
  it("runs the migration CLI through a silent pnpm so workspace warnings cannot reach the receipt", async () => {
    const command = vi.fn(async () => JSON.stringify({ mode: "plan" }));
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
});
