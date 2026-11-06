import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSettingsFile, updateSettingsFile } from "../files";

// toml-patch has returned broken documents without throwing. Force each shape
// so the writer's round-trip guard stays covered whatever the library does.
const patched = vi.hoisted(() => ({ text: "" }));
vi.mock("@decimalturn/toml-patch", () => ({ patch: () => patched.text }));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "zeros-settings-guard-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it.each([
  ["invalid TOML", '[mcp]\nservers = [{name="b",transport="http",url="https://y"]\n'],
  ["valid TOML without the requested data", "[mcp]\n"],
])("rewrites the whole file when the patch returns %s", (_shape, text) => {
  // Writing it would wedge every later write ("refusing to overwrite malformed")
  // or silently drop the change.
  patched.text = text;
  const file = path.join(dir, "settings.toml");
  writeFileSync(file, '[mcp]\nservers = [{name="a",transport="stdio",command="x"}]\n', "utf8");
  const servers = [{ name: "b", transport: "http", url: "https://y" }];
  updateSettingsFile(file, { mcp: { servers } }, { schemaUrl: null });
  const read = readSettingsFile(file);
  expect(read.error).toBeUndefined();
  expect((read.doc.mcp as { servers: unknown[] }).servers).toEqual(servers);
});
