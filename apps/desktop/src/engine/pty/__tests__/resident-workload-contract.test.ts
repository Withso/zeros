import {randomUUID} from "node:crypto";
import {describe, expect, it} from "vitest";
import {
  ResidentPtyRequestSchema,
  ResidentWorkloadCensusRequestSchema,
  ResidentWorkloadClassificationSchema,
  residentWorkloadClassificationMatchesRequest,
} from "../resident-protocol";

const authority = {organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(), generation: 3, fence: 7};
const request = {version: 1 as const, requestId: randomUUID(), censusSha256: "a".repeat(64),
  common: {directory: "/sys/fs/cgroup/zeros/engine-runtime", dev: "29", ino: "302"}};
const terminal = {executionId: "resident-original", generation: "host-original-generation",
  supervisor: {pid: 200, startToken: "100"}, shell: {pid: 201, startToken: "101"},
  targetExecutable: {dev: "3", ino: "404"}, noRecentInput: true as const};
const reply = {...request, authority, owner: {pid: 100, startToken: "90"}, complete: true,
  pendingLaunches: 0, failedRetirements: 0, quietTerminals: [terminal]};

describe("resident original-owner classification wire", () => {
  it("admits only the additive exact classification request while retaining the old inspection", () => {
    expect(ResidentPtyRequestSchema.safeParse({id: 1, op: "classify-workloads", census: request}).success).toBe(true);
    expect(ResidentPtyRequestSchema.safeParse({id: 2, op: "inspect-workloads"}).success).toBe(true);
    expect(ResidentPtyRequestSchema.safeParse({id: 1, op: "classify-workloads", census: request, pid: 100}).success).toBe(false);
  });
  it("retains the strict nonsecret request and exact original birth facts", () => {
    expect(ResidentWorkloadCensusRequestSchema.parse(request)).toEqual(request);
    expect(ResidentWorkloadClassificationSchema.parse(reply)).toEqual(reply);
    expect(residentWorkloadClassificationMatchesRequest(reply, request, authority)).toBe(true);
  });
  it.each(["request", "census", "directory", "inode", "device"])("refuses a %s mismatch without adopting the supplied tree", field => {
    const changed = {...reply, common: {...reply.common}};
    if (field === "request") changed.requestId = randomUUID();
    if (field === "census") changed.censusSha256 = "b".repeat(64);
    if (field === "directory") changed.common.directory += "/foreign";
    if (field === "inode") changed.common.ino = "303";
    if (field === "device") changed.common.dev = "30";
    expect(residentWorkloadClassificationMatchesRequest(changed, request, authority)).toBe(false);
  });
  it.each(["organizationId", "workspaceId", "engineId", "generation", "fence"])("binds the current captured %s", field => {
    const changed = {...reply, authority: {...authority, [field]: field === "generation" || field === "fence" ? 8 : randomUUID()}};
    expect(residentWorkloadClassificationMatchesRequest(changed, request, authority)).toBe(false);
  });
  it("rejects unbounded or conflicting scope/member classifications", () => {
    for (const quietTerminals of [Array.from({length: 33}, () => terminal), [terminal, {...terminal}],
      [terminal, {...terminal, executionId: "other", supervisor: {...terminal.supervisor}, shell: {pid: 202, startToken: "102"}}],
      [terminal, {...terminal, executionId: "other", supervisor: {pid: 202, startToken: "102"}, shell: {...terminal.shell}}]])
      expect(ResidentWorkloadClassificationSchema.safeParse({...reply, quietTerminals}).success).toBe(false);
  });
  it("rejects noncanonical kernel identities and unknown payload fields", () => {
    for (const changed of [{...reply, owner: {pid: 0, startToken: "90"}}, {...reply, owner: {pid: 100, startToken: "090"}},
      {...reply, owner: terminal.supervisor}, {...reply, common: {...reply.common, ino: "0302"}},
      {...reply, common: {...reply.common, directory: "/sys/fs/cgroup/../foreign"}},
      {...reply, authority: {...authority, token: "private material"}},
      {...reply, quietTerminals: [{...terminal, noRecentInput: false}]},
      {...reply, quietTerminals: [{...terminal, command: "never transported"}]}])
      expect(ResidentWorkloadClassificationSchema.safeParse(changed).success).toBe(false);
  });
  it("retains incomplete original-owner evidence without claiming it is a quiet proof", () => {
    const incomplete = {...reply, complete: false, pendingLaunches: 1, failedRetirements: 1, quietTerminals: []};
    expect(ResidentWorkloadClassificationSchema.parse(incomplete)).toEqual(incomplete);
  });
});
