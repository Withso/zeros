// Resolver cascade for the embedded-terminal `claude` binary. The PTY is a
// login shell, so the bare-name fallback always works — but a resolved
// absolute path gives a clean visible command + covers a minimal engine PATH.
// `home`/`pathValue` are injected so the test doesn't depend on the host's
// real installs (the dev machine has a real ~/.local/bin/claude).

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { resolveClaudeBinary } from "../claude-binary";

const tmpDirs: string[] = [];

function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bin-"));
  tmpDirs.push(d);
  return d;
}

/** Create an executable `claude` file at `dir/<rel>` and return its path. */
function makeClaude(dir: string, rel: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
  return p;
}

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe("resolveClaudeBinary", () => {
  it("uses an existing override first", async () => {
    const dir = freshDir();
    const override = makeClaude(dir, "my-claude");
    const r = await resolveClaudeBinary({
      override,
      candidates: [],
      pathValue: "",
    });
    expect(r).toEqual({ path: override, source: "override" });
  });

  it("ignores a missing override and falls through", async () => {
    const dir = freshDir();
    const r = await resolveClaudeBinary({
      override: path.join(dir, "does-not-exist"),
      candidates: [],
      pathValue: "",
    });
    expect(r.source).toBe("fallback");
    expect(r.path).toBe("claude");
  });

  it("finds a well-known install before PATH", async () => {
    const dir = freshDir();
    const wellKnown = makeClaude(dir, path.join(".claude", "local", "claude"));
    // A different claude on PATH must NOT win — well-known has priority.
    const pathDir = freshDir();
    makeClaude(pathDir, "claude");
    const r = await resolveClaudeBinary({
      candidates: [path.join(dir, "missing"), wellKnown],
      pathValue: pathDir,
    });
    expect(r).toEqual({ path: wellKnown, source: "well-known" });
  });

  it("scans PATH when no well-known install exists", async () => {
    const pathDir = freshDir();
    const onPath = makeClaude(pathDir, "claude");
    const r = await resolveClaudeBinary({
      candidates: [], // no well-known claude
      pathValue: `/nope${path.delimiter}${pathDir}`,
    });
    expect(r).toEqual({ path: onPath, source: "path" });
  });

  it("falls back to the bare name when nothing resolves", async () => {
    const r = await resolveClaudeBinary({ candidates: [], pathValue: "" });
    expect(r).toEqual({ path: "claude", source: "fallback" });
  });
});
