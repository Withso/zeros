import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8");
const prose = (file: string) => read(file).replace(/\s+/g, " ");

describe("documented VM execution posture", () => {
  it("states one non-root identity, the exact map and shared VM trust", () => {
    const security = prose("docs/cloud-workspace/security.md");
    expect(security).toContain("## Agent execution model");
    expect(security).toContain("VM is the isolation boundary");
    expect(security).toContain("one non-root user");
    expect(security).toContain("`zeros-engine`");
    expect(security).toContain("VM UID/GID 10003");
    expect(security).toContain("10003->10003");
    expect(security).toContain("all capability sets are empty");
    expect(security).toContain("NoNewPrivs");
    expect(security).toContain("seccomp");
    expect(security).toContain("locked mount namespace");
    expect(security).toContain("without an agent sandbox");
    expect(security).toContain("Agents can read engine data");
    expect(security).toContain("one trust domain per workspace");
    expect(security).toContain("state separation, not a security boundary");
    expect(security).toContain("normal VM egress");
    expect(security).not.toContain("CAP_SETFCAP");
  });

  it("does not promise inter-conversation secrecy from ordinary directories", () => {
    const auth = read(
      "docs/cloud-workspace/agent-authentication-and-language-tools.md",
    );
    expect(auth).toContain("`zeros-engine`");
    expect(auth).toContain("10003");
    expect(auth).not.toContain(
      "Engine state, other\nconversations and other accounts remain outside their view",
    );
    expect(auth).toContain("state separation, not a security boundary");
    expect(
      prose("docs/cloud-workspace/agent-authentication-and-language-tools.md"),
    ).toContain("Agents can read engine data");
    expect(read("docs/agent-harness-capability-boundary.md")).not.toContain(
      "private UID-10001 native boundary",
    );
    expect(read("docs/cloud-workspace/architecture.md")).not.toContain(
      "UID-10001 session lifetime",
    );
  });

  it("retains the archived base account schema and uses 10003 for current tools", () => {
    const bundles = read("docs/cloud-workspace/runtime-bundles.md");
    expect(bundles).toContain(
      "uids:{agent:10001,capture:10002,coordinator:10004,engine:10003}",
    );
    expect(bundles).toContain("immutable base compatibility");
    expect(bundles).not.toContain("payload as worker");
    expect(bundles).toContain("offline artifact closure");
    expect(prose("docs/cloud-workspace/native-access-acceptance.md")).toContain(
      "UID 10003, selected primary checkout",
    );
  });

  it("keeps browser sandboxing distinct from cloud agent execution", () => {
    const design = read("docs/design-mode-roadmap.md");
    expect(design).not.toMatch(/pinned ZSR supervisor|check:zsr/);
    expect(design).toContain("UID 10003");
    expect(design).toContain("Chromium sandboxing is explicitly enabled");
    expect(design).toContain("Cloud retains API authoring for now");
    expect(design).toContain("not OS-enforced");
    expect(design).toContain("__zsr_cap");
  });

  it("uses neutral current development and release commands", () => {
    expect(read("docs/local-development.md")).not.toContain("builds ZSR");
    expect(read("docs/local-development.md")).toContain("pinned ripgrep");
    expect(read("docs/deployment-environments.md")).not.toMatch(
      /shipping-kernel ZSR qualification|ZSR kernel/,
    );
  });

  it("publishes the same execution model in repository and generated workspace guidance", () => {
    for (const file of [
      "AGENTS.md",
      "RULES.md",
      ".agents/skills/zeros-workspaces/SKILL.md",
      ".claude/skills/zeros-workspaces/SKILL.md",
      ".cursor/rules/zeros-workspaces.mdc",
    ]) {
      expect(prose(file), file).toContain(
        "state separation, not a security boundary",
      );
      expect(read(file), file).toContain("`zeros-engine`");
      expect(prose(file), file).toContain("one non-root user");
      expect(prose(file), file).toContain("without an agent sandbox");
      expect(prose(file), file).toContain("Agents can read engine data");
    }
  });

  it("requires a complete engine-tree census and outside-broker final VM proof", () => {
    for (const file of [
      "docs/cloud-workspace/security.md",
      "docs/cloud-workspace/provider-background-work.md",
      "docs/cloud-workspace/client-runtime-contract.md",
      "docs/cloud-workspace/runtime-bundles.md",
      "docs/cloud-workspace/native-access-acceptance.md",
      "docs/design-mode-roadmap.md",
    ]) {
      const content = prose(file);
      expect(content, file).toContain("original broker");
      expect(content, file).toContain("one shared workload cgroup");
      expect(content, file).toContain("fresh complete census");
      expect(content, file).toContain("cgroup.kill");
      expect(content, file).toContain("populated=0");
      expect(content, file).toContain(
        "checkpoint and seal complete before kill",
      );
      expect(content, file).toContain("outside root broker");
    }
    const security = prose("docs/cloud-workspace/security.md");
    expect(security).not.toContain("kernel scopes where available");
    expect(security).toContain("Unknown means busy");
    expect(security).toContain("C3 quiet populated-shell exception");
    expect(security).toContain("engine leaf and any new sibling");
    expect(security).toContain("exact infrastructure births");
    expect(security).toContain(
      "per-conversation Stop proves only the original process group",
    );
    expect(security).toContain(
      "escaped or detached descendants are not proven retired",
    );
    expect(security).toContain(
      "Local Host process-group behavior is unchanged",
    );
  });

  it("does not confuse cgroup migration permission with target UID protection", () => {
    for (const file of [
      "docs/cloud-workspace/security.md",
      "docs/cloud-workspace/architecture.md",
      "docs/cloud-workspace/infrastructure-and-operations.md",
    ]) {
      const content = prose(file);
      expect(content, file).toContain(
        "destination and common-ancestor write access",
      );
      expect(content, file).toContain("not the target UID");
      expect(content, file).toContain(
        "every root process stays outside engine-runtime",
      );
      expect(content, file).toContain("no root helper inside");
      expect(content, file).toContain("`/host`");
    }
  });

  it("documents scaled parent bounds and the workload-only CPU percentage", () => {
    for (const file of [
      "docs/cloud-workspace/architecture.md",
      "docs/cloud-workspace/infrastructure-and-operations.md",
    ]) {
      const content = prose(file);
      expect(content, file).toContain("effective CPU count");
      expect(content, file).toContain(
        "engine's own cgroup and exact ancestors",
      );
      expect(content, file).toContain("cpuset.cpus.effective");
      expect(content, file).toContain(
        "round(0.75 * min(raw cpuset CPUs, actual ancestor quota in CPUs) * 100000)",
      );
      expect(content, file).toContain("engine cgroup stays uncapped");
      expect(content, file).toContain("cpu.weight=100");
      expect(content, file).toContain("no new per-leaf memory/pids limits");
      expect(content, file).toContain("inherited parent bounds remain");
      expect(content, file).toContain("engine-runtime parent");
      expect(content, file).toContain("admitted SKU CPUs * 100000");
      expect(content, file).toContain(
        "nominal SKU memory minus 1 GiB",
      );
      expect(content, file).toContain("pids.max=4096");
      expect(content, file).toContain("memory.oom.group=1");
      expect(content, file).toContain(
        "default 4 vCPU / 8 GiB SKU matches main",
      );
      expect(content, file).toContain("400000 100000");
      expect(content, file).toContain("7516192768");
      expect(content, file).toContain(
        "parent falls back to main's exact constants",
      );
      expect(content, file).toContain(
        "cap stays uncapped with a closed diagnostic",
      );
      expect(content, file).toContain("shared custody remains mandatory");
      expect(content, file).toContain("never falls back to os.cpus()");
      expect(content, file).toContain("`/host` limits are unchanged");
      for (const [cpus, quota] of [
        [1, 75000],
        [2, 150000],
        [4, 300000],
        [8, 600000],
        [16, 1200000],
      ]) {
        expect(content, file).toContain(`| ${cpus} | ${quota} 100000 |`);
      }
      for (const [gib, bytes] of [
        [4, 3221225472],
        [8, 7516192768],
        [16, 16106127360],
      ]) {
        expect(content, file).toContain(`| ${gib} GiB | ${bytes} |`);
      }
    }
  });

  it.each([
    "docs/cloud-workspace/architecture.md",
    "docs/cloud-workspace/infrastructure-and-operations.md",
  ])("keeps a wider raw cpuset within admitted parent and ancestor quotas in %s", (file) => {
    const content = prose(file);
    expect(content).toContain("admitted SKU CPUs * 100000");
    expect(content).toContain(
      "round(0.75 * min(raw cpuset CPUs, actual ancestor quota in CPUs) * 100000)",
    );
    expect(content).toContain(
      "CPU examples assume admitted SKU CPUs, raw cpuset CPUs and actual ancestor quota coincide",
    );
    expect(content).toContain("| 4 | 8 | 4 | 400000 100000 | 300000 100000 |");
    expect(content).toContain("quota / period");
    expect(content).toContain("including the newly set parent");
    expect(content).not.toContain("`effective CPUs * 100000`");
    expect(content).not.toContain("round(0.75 * effective CPUs * 100000)");
  });

  it.each([
    "docs/cloud-workspace/architecture.md",
    "docs/cloud-workspace/infrastructure-and-operations.md",
  ])("keeps nominal memory, measured ceiling and admission distinct in %s", (file) => {
    const content = prose(file);
    expect(content).toContain("configured/admitted allocation");
    expect(content).toContain(
      "min(nominal SKU memory - 1 GiB, measured MemTotal - /host memory limit)",
    );
    expect(content).toContain("nominal parent budget before measured cap");
    expect(content).toContain(
      "report records nominal memory, measured MemTotal, `/host` memory limit and effective cap",
    );
    expect(content).toContain("existing SKU sufficiency floor");
    expect(content).toContain("normal kernel overhead is accepted");
    expect(content).toContain("7 GiB (7516192768 bytes)");
    expect(content).toContain("v1 reports remain byte-for-byte unchanged");
    expect(content).not.toContain(
      "measured VM memory allocation minus 1 GiB",
    );
  });

  it.each([
    "docs/cloud-workspace/architecture.md",
    "docs/cloud-workspace/infrastructure-and-operations.md",
  ])("documents exact fallback bounds independently from measurements in %s", (file) => {
    const content = prose(file);
    expect(content).toContain("`memoryBudget.source=nominal`");
    expect(content).toContain("`memoryBudget.source=fallback`");
    expect(content).toContain(
      "fallback parent is exactly `cpu.max=400000 100000`, `memory.max=7516192768`, `pids.max=4096`, `memory.oom.group=1`",
    );
    expect(content).toContain("fallback applies no MemTotal or `/host` cap");
    expect(content).toContain(
      "measured memory cap applies only in nominal mode",
    );
    expect(content).toContain("report's root-published `memoryBudget.source`");
    expect(content).toContain(
      "Record raw measurements honestly; never infer the mode from them",
    );
    expect(content).toContain("assigned by the broker");
    expect(content).toContain("strict per-mode equality");
    expect(content).toContain(
      "nominal CPU must equal the admitted SKU CPU count",
    );
    expect(content).toContain(
      "fallback requires the matching workload-cap skip diagnostic",
    );
    expect(content).not.toContain("boundsMode");
  });

  it("removes superseded engine privacy and active worker-account claims", () => {
    for (const file of [
      "docs/agent-capabilities-parity-and-ui-consolidated-2026-07-01.md",
      "docs/agent-harness-capability-boundary.md",
      "docs/cloud-workspace/agent-authentication-and-language-tools.md",
      "docs/cloud-workspace/architecture.md",
      "docs/cloud-workspace/client-runtime-contract.md",
      "docs/cloud-workspace/computer-environment.md",
      "docs/cloud-workspace/computer-template-builds.md",
      "docs/cloud-workspace/infrastructure-and-operations.md",
      "docs/cloud-workspace/mcp-and-skills.md",
      "docs/cloud-workspace/native-access-acceptance.md",
      "docs/cloud-workspace/provider-background-work.md",
      "docs/cloud-workspace/release-worker-qualification.md",
      "docs/cloud-workspace/runtime-bundles.md",
      "docs/cloud-workspace/security.md",
      "docs/deployment-environments.md",
      "docs/design-mode-roadmap.md",
      "docs/local-development.md",
    ]) {
      expect(prose(file), file).not.toMatch(
        /Engine data (?:is|remains) private to the engine user|remain(?:s)? unreadable to agents|checkouts keep ownership 10001|paths as the existing capture account \(UID 10002\)/i,
      );
    }
  });
});
