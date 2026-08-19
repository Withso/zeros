import { describe, expect, it } from "vitest";

// @ts-expect-error — the qualification helper is an ESM script without declarations.
import { buildQualificationCommand } from "../zsr-qualification/command.mjs";

describe("ZSR qualification command", () => {
  it("runs debug diagnostics before the resource-limit shell program", () => {
    const command = buildQualificationCommand({
      debug: true,
      diagnostics: ["id >&2", "stat '/tmp/probe' >&2"],
      resourcePrelude: "zsr_cap_hard_limit() { :; }; ",
      environmentPrelude: "TOKEN='value' ",
      argv: ["/usr/bin/node", "/tmp/probe", "argument with spaces"],
    });

    expect(command).toContain("id >&2; stat '/tmp/probe' >&2; ");
    expect(command).toContain(
      "zsr_cap_hard_limit() { :; }; TOKEN='value' exec",
    );
    expect(command).toContain(
      "'/usr/bin/node' '/tmp/probe' 'argument with spaces'",
    );
    // `exec` may only prefix the final executable. Prefixing a shell function
    // declaration produces `bash: syntax error near unexpected token '('`.
    expect(command).not.toContain("; exec zsr_cap_hard_limit()");
  });

  it("keeps the non-debug command free of diagnostic side effects", () => {
    expect(
      buildQualificationCommand({
        debug: false,
        diagnostics: ["id >&2"],
        resourcePrelude: "",
        environmentPrelude: "",
        argv: ["/bin/true"],
      }),
    ).toBe("exec '/bin/true'");
  });
});
