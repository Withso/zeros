import { describe, expect, it } from "vitest";

import { codexAppServerFeatureArgs } from "../app-server";

describe("codex app-server auth storage", () => {
  it("uses file stores for the selected cloud process HOME", () => {
    expect(codexAppServerFeatureArgs(true)).toEqual(
      expect.arrayContaining([
        'cli_auth_credentials_store="file"',
        'mcp_oauth_credentials_store="file"',
      ]),
    );
  });

  it("does not change the Local user's credential-store choice", () => {
    const args = codexAppServerFeatureArgs(false);
    expect(args).not.toContain('cli_auth_credentials_store="file"');
    expect(args).not.toContain('mcp_oauth_credentials_store="file"');
  });
});
