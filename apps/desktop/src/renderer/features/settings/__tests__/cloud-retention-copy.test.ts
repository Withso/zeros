import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLOUD_RETENTION_BACKUP_DAYS, CLOUD_RETENTION_INACTIVE_DAYS, CLOUD_RETENTION_MACHINE_DAYS, CLOUD_RETENTION_RULE, cloudArchiveLine } from "../cloud-retention-copy";

const server = (file: string) => readFileSync(fileURLToPath(new URL(`../../../../../../control-plane/src/cloud/${file}`, import.meta.url)), "utf8");
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const later = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

describe("retention's rule on General", () => {
  it("uses the server's own numbers", () => {
    expect(server("lifecycle.ts")).toContain(`CLOUD_V2_INACTIVE_ARCHIVE_MS = ${CLOUD_RETENTION_INACTIVE_DAYS} * 24 * 60 * 60_000`);
    expect(server("store.ts")).toContain(`CLOUD_V2_BACKUP_REMOVAL_DAYS = ${CLOUD_RETENTION_BACKUP_DAYS};`);
    // 24 = the archived workspace's one wake 10 days after its stop, then Boat's 14 (store.ts archiveFields).
    expect(server("store.ts")).toContain(`(woken ? 14 : ${CLOUD_RETENTION_MACHINE_DAYS})`);
    expect(server("store.ts")).toContain("greatest(machine_stopped_at, stopped_at) + interval '10 days'");
    expect(CLOUD_RETENTION_MACHINE_DAYS).toBe(10 + 14);
    const rule = CLOUD_RETENTION_RULE.join(" ");
    for (const days of [CLOUD_RETENTION_INACTIVE_DAYS, CLOUD_RETENTION_MACHINE_DAYS, CLOUD_RETENTION_BACKUP_DAYS]) expect(rule).toContain(` ${days} days`);
  });

  it("never says a machine or backup goes from a workspace that is not archived", () => {
    for (const sentence of CLOUD_RETENTION_RULE.join(" ").split(/(?<=\.) /)) {
      if (/machine|backup/i.test(sentence)) expect(sentence, sentence).toMatch(/archived|the backup is removed|After that/);
    }
    expect(CLOUD_RETENTION_RULE.join(" ")).not.toMatch(/after it stops|stopped workspace/i);
    expect(CLOUD_RETENTION_RULE[1]).toMatch(/^After a workspace is archived, its machine/);
  });
});

describe("an archived cloud workspace's line", () => {
  it("says why for each reason, and what opening it brings back", () => {
    expect(cloudArchiveLine({ keep: false, archiveReason: "inactive", restores: "all" }, true, NOW, "en-US"))
      .toBe("Archived after 30 days without activity. Opening it restores everything.");
    expect(cloudArchiveLine({ keep: false, archiveReason: "member_left", restores: "pushed" }, true, NOW, "en-US"))
      .toBe("Archived when its creator left the organization. Opening it rebuilds it from GitHub. Work that was never pushed is gone.");
    expect(cloudArchiveLine({ keep: false, archiveReason: "manual" }, true, NOW, "en-US")).toBe("Archived.");
  });

  it("gives the machine's and the backup's dates in plain words, and what the backup date means", () => {
    const line = cloudArchiveLine({ keep: false, archiveReason: "inactive", restores: "all", machineExpectedGoneAt: { at: later(14), estimate: true },
      backupRemovalAt: later(60) }, true, NOW, "en-US")!;
    expect(line).toContain("Its machine is removed around Dec 6, 2026.");
    expect(line).toContain("Backup kept until Jan 21, 2027. After that, only what was pushed to GitHub can be restored.");
    expect(cloudArchiveLine({ keep: false, machineExpectedGoneAt: { at: later(-1), estimate: false } }, true, NOW, "en-US")).toBe("Its machine was removed on Nov 21, 2026.");
    expect(cloudArchiveLine({ keep: false, machineExpectedGoneAt: { at: later(3), estimate: false } }, true, NOW, "en-US")).toBe("Its machine is removed on Nov 25, 2026.");
  });

  it("after the backup is gone says it rebuilds from GitHub, and shows no backup date", () => {
    expect(cloudArchiveLine({ keep: false, archiveReason: "inactive", restores: "pushed", backupRemovalAt: later(1) }, true, NOW, "en-US"))
      .toBe("Archived after 30 days without activity. Opening it rebuilds it from GitHub. Work that was never pushed is gone.");
  });

  it("says nothing without retention, for a workspace that is not archived, or with nothing to say", () => {
    expect(cloudArchiveLine(undefined, true, NOW)).toBeNull();
    expect(cloudArchiveLine({ keep: true }, false, NOW)).toBeNull();
    expect(cloudArchiveLine({ keep: false }, true, NOW)).toBeNull();
  });
});
