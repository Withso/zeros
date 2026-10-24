import { describe, expect, it } from "vitest";
import { McpHostControl } from "../host-control";

const admission = { organizationId: "c7cfd908-52ac-49c1-b559-484388f8ff22", repository: "example/repo", runtimeId: "2cbe0ff4-037d-4bb8-8989-68c0a8333ac0" };
const setup = () => {
  const sent: Array<{ requestId: string; action: string; accountId?: string }> = [];
  const control = new McpHostControl(line => sent.push(JSON.parse(line)));
  const reply = (index: number, data: unknown) => control.accept({ type: "host.mcp.response", requestId: sent[index]!.requestId, data });
  return { control, sent, reply };
};
describe("private MCP host control", () => {
  it("binds authorization to the resolved account and rejects a different account reply", async () => {
    const { control, sent, reply } = setup();
    const resolved = control.resolve(admission);
    reply(0, { accountId: "one", servers: [] });
    await expect(resolved).resolves.toEqual({ accountId: "one", servers: [] });
    await expect(control.authorize(admission, admission.runtimeId, "two")).rejects.toThrow("MCP request could not complete.");
    const auth = control.authorize(admission, admission.runtimeId, "one");
    expect(sent[1]?.accountId).toBe("one");
    reply(1, { accountId: "two", headers: { Authorization: "private" } });
    await expect(auth).rejects.toThrow("MCP request could not complete.");
    control.close();
  });
  it("cancels all requests on account change and ignores late responses", async () => {
    const { control, reply } = setup();
    const old = control.resolve(admission);
    control.reset();
    await expect(old).rejects.toThrow();
    reply(0, { accountId: "old", servers: [] });
    const next = control.resolve(admission);
    reply(1, { accountId: "new", servers: [] });
    await expect(next).resolves.toMatchObject({ accountId: "new" });
    expect(control.isCurrent(0, "old")).toBe(false);
    expect(control.isCurrent(1, "new")).toBe(true);
    control.close();
  });
  it("bounds concurrent requests and strips malformed or private error details", async () => {
    const { control, reply } = setup();
    const flights = Array.from({ length: 8 }, () => control.resolve(admission).catch(error => error.message));
    await expect(control.resolve(admission)).rejects.toThrow("MCP request could not complete.");
    reply(0, { accountId: "one", servers: [{ transport: "stdio", env: { PRIVATE: "value" } }] });
    control.close();
    expect(await Promise.all(flights)).toEqual(Array(8).fill("MCP request could not complete."));
  });
  it("removes cancelled requests without retaining listeners or accepting late credentials", async () => {
    const { control, reply } = setup();
    const abort = new AbortController();
    const result = control.resolve(admission, abort.signal);
    abort.abort();
    await expect(result).rejects.toThrow();
    reply(0, { accountId: "cancelled", servers: [] });
    expect(control.isCurrent(0, "cancelled")).toBe(false);
    control.close();
  });
});
