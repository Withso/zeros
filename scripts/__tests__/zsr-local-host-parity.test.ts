import { describe, expect, it, vi } from "vitest";

import { QUALIFICATION_WRITE_PROBE_SOURCE } from "../zsr-qualification/write-probe-source";

type QualificationWriteProbe = (
  fileSystem: {
    mkdirSync(root: string, options: { recursive: boolean }): void;
    writeFileSync(file: string, contents: string): void;
    readFileSync(file: string, encoding: string): string;
  },
  pathApi: { join(root: string, file: string): string },
  root: string | undefined,
  file: string,
) => boolean;

function loadProbe(): QualificationWriteProbe {
  return Function(
    `"use strict"; ${QUALIFICATION_WRITE_PROBE_SOURCE}; return qualificationWriteProbe;`,
  )() as QualificationWriteProbe;
}

describe("ZSR host-parity write evidence", () => {
  it("reports missing provider roots and write failures instead of crashing the fixture", () => {
    const probe = loadProbe();
    const pathApi = { join: (root: string, file: string) => `${root}/${file}` };
    const fileSystem = {
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(() => {
        throw new Error("denied");
      }),
      readFileSync: vi.fn(() => "provider-write\n"),
    };

    expect(probe(fileSystem, pathApi, undefined, "missing.txt")).toBe(false);
    expect(probe(fileSystem, pathApi, "/state", "denied.txt")).toBe(false);
  });

  it("returns true only after the exact probe bytes round-trip", () => {
    const probe = loadProbe();
    const pathApi = { join: (root: string, file: string) => `${root}/${file}` };
    const fileSystem = {
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => "provider-write\n"),
    };

    expect(probe(fileSystem, pathApi, "/state", "ok.txt")).toBe(true);
    expect(fileSystem.mkdirSync).toHaveBeenCalledWith("/state", {
      recursive: true,
    });
  });
});
