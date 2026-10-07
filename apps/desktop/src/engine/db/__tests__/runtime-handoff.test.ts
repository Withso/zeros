import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeZerosDb, openZerosDb, resumeZerosDbAfterRuntimeHandoff,
  sealZerosDbForRuntimeHandoff, setZerosDbPathForTesting } from "../database";

let directory: string | undefined;
afterEach(() => {
  closeZerosDb(); setZerosDbPathForTesting(null);
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});
function database() {
  directory = mkdtempSync(path.join(tmpdir(), "zeros-runtime-handoff-"));
  setZerosDbPathForTesting(path.join(directory, "zeros.db"));
  const db = openZerosDb(); db.exec("CREATE TABLE handoff_probe(value TEXT)"); return db;
}

describe("cloud runtime SQLite handoff", () => {
  it("closes the old handle and rejects late opens until an explicit cancellation resumes it", () => {
    const db = database(); db.prepare("INSERT INTO handoff_probe VALUES (?)").run("committed");
    sealZerosDbForRuntimeHandoff();
    expect(db.open).toBe(false);
    expect(() => openZerosDb()).toThrow("runtime handoff");
    // Ordinary teardown cannot accidentally clear the handoff barrier.
    closeZerosDb();
    expect(() => openZerosDb()).toThrow("runtime handoff");
    sealZerosDbForRuntimeHandoff(); resumeZerosDbAfterRuntimeHandoff();
    expect(openZerosDb()).not.toBe(db);
    expect(openZerosDb().prepare("SELECT value FROM handoff_probe").get()).toEqual({ value: "committed" });
  });
  it("refuses an unfinished transaction without closing it or losing its writes", () => {
    const db = database(); db.exec("BEGIN");
    db.prepare("INSERT INTO handoff_probe VALUES (?)").run("pending");
    expect(() => sealZerosDbForRuntimeHandoff()).toThrow("transaction");
    expect(openZerosDb()).toBe(db); expect(db.inTransaction).toBe(true);
    db.exec("COMMIT"); sealZerosDbForRuntimeHandoff(); resumeZerosDbAfterRuntimeHandoff();
    expect(openZerosDb().prepare("SELECT value FROM handoff_probe").get()).toEqual({ value: "pending" });
  });
  it("leaves normal Local and organization-local close/reopen behavior unchanged", () => {
    const db = database(); closeZerosDb();
    expect(db.open).toBe(false);
    expect(openZerosDb().open).toBe(true);
  });
});
