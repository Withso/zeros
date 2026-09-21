import { describe, expect, it } from "vitest";
// @ts-expect-error The image helper is plain Node JavaScript.
import { validateCloudSetupPayload } from "../cloud-workspace-validation/sandbox/cloud-setup-process.mjs";
const valid = () => ({
  version: 1,
  command: "node --version",
  timeoutMs: 30000,
  environment: { PACKAGE_TOKEN: "test-only-package-token" },
});
describe("bounded unprivileged setup process", () => {
  it("keeps setup command and secrets as data with a fixed worker identity and directory", () => {
    expect(validateCloudSetupPayload(valid())).toEqual(valid());
    for (const change of [
      { uid: 0 },
      { cwd: "/root" },
      { executable: "/bin/bash" },
      { timeoutMs: 0 },
      { timeoutMs: 3600001 },
      { command: "" },
      { environment: { NODE_OPTIONS: "--require=/tmp/code" } },
      { environment: { PATH: "/tmp" } },
      { environment: { LD_PRELOAD: "/tmp/code" } },
      { environment: { "BASH_FUNC_fn%%": "() {}" } },
      { environment: { TOKEN: "a\0b" } },
    ])
      expect(() =>
        validateCloudSetupPayload({ ...valid(), ...change }),
      ).toThrow(/setup process/);
  });
});
