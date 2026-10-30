import { createHash } from "node:crypto";
import fs, { type BigIntStats, type Stats } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestTranscript, readBounded } from "../zstack/transcript.mjs";
import { privateFixtureRoot } from "./zstack-fixtures";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function duringSizeObservation<T>(file: string, mutate: () => void, read: () => T) {
  const original = { openSync: fs.openSync, statSync: fs.statSync, fstatSync: fs.fstatSync };
  const handles = new Set<number>();
  let observations = 0;
  const instrument = <S extends Stats | BigIntStats>(info: S): S => {
    const size = info.size;
    // Both pathname and descriptor readers receive the pre-mutation metadata.
    Object.defineProperty(info, "size", { get() {
      if (observations === 0) { observations++; mutate(); }
      return size;
    } });
    return info;
  };
  fs.openSync = (path, flags, mode) => {
    const handle = original.openSync(path, flags, mode);
    if (path === file) handles.add(handle);
    return handle;
  };
  fs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
    const info = original.statSync(...args);
    return args[0] === file && info ? instrument(info) : info;
  }) as typeof fs.statSync;
  fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
    const info = original.fstatSync(...args);
    return handles.has(args[0]) ? instrument(info) : info;
  }) as typeof fs.fstatSync;
  syncBuiltinESMExports();
  try { return { value: read(), observations }; }
  finally { Object.assign(fs, original); syncBuiltinESMExports(); }
}

const transcript = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

function fixtureText(file: string) {
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    expect(fs.fstatSync(handle).isFile()).toBe(true);
    return fs.readFileSync(handle, "utf8");
  } finally { fs.closeSync(handle); }
}

describe("zstack transcript file custody", () => {
  it("digests the checked file when its pathname is replaced before the read", async () => {
    const root = await privateFixtureRoot(roots), file = join(root, "session.jsonl");
    const replacement = join(root, "replacement.jsonl");
    const original = transcript("Original request"), changed = transcript("Replacement request");
    await writeFile(file, original, { mode: 0o600 });
    await writeFile(replacement, changed, { mode: 0o600 });

    const result = duringSizeObservation(file, () => fs.renameSync(replacement, file),
      () => digestTranscript(readBounded(file, 1024), { file }));

    expect(result.observations, "the reader must encounter the held race").toBe(1);
    expect(fixtureText(file), "the pathname must actually change").toBe(changed);
    expect(result.value.sha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(result.value.events.map((event: { text: string }) => event.text)).toEqual(["Original request"]);
  });

  it("refuses growth past the limit after the last size observation", async () => {
    const root = await privateFixtureRoot(roots), file = join(root, "session.jsonl");
    await writeFile(file, "small", { mode: 0o600 });

    const result = duringSizeObservation(file, () => fs.appendFileSync(file, " plus more bytes"),
      () => readBounded(file, 8));

    expect(result.observations, "the reader must encounter the held race").toBe(1);
    expect(fixtureText(file), "the file must actually grow").toBe("small plus more bytes");
    expect(result.value).toBeNull();
  });

  it("accepts unchanged input and growth that stays within the limit", async () => {
    const root = await privateFixtureRoot(roots), file = join(root, "session.jsonl");
    await writeFile(file, "small", { mode: 0o600 });
    expect(readBounded(file, 8)).toBe("small");

    const result = duringSizeObservation(file, () => fs.appendFileSync(file, " ok"),
      () => readBounded(file, 8));

    expect(result.observations).toBe(1);
    expect(result.value).toBe("small ok");
  });
});
