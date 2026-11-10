import { describe, expect, it } from "vitest";
import { cleanDeviceName, computerName, deviceIdFor } from "../local-commands/device-identity";

describe("local command device identity", () => {
  it("keeps one id per account and install, and never shares it between accounts", () => {
    const values = new Map<string, string>(), store = { get: (key: string) => values.get(key) ?? "", set: (key: string, value: string) => { values.set(key, value); } };
    const a = deviceIdFor(store, "account-a"), again = deviceIdFor(store, "account-a"), b = deviceIdFor(store, "account-b");
    expect(again).toBe(a); expect(b).not.toBe(a);
    for (const key of values.keys()) expect(key).not.toContain("account");
  });

  it("names the Mac by ComputerName, falling back to its host name, within the wire's bounds", async () => {
    expect(await computerName({ platform: "darwin", run: async () => "Alex's MacBook Pro\n", host: () => "ignored" })).toBe("Alex's MacBook Pro");
    expect(await computerName({ platform: "darwin", run: async () => { throw new Error("no scutil"); }, host: () => "studio.local" })).toBe("studio");
    expect(await computerName({ platform: "linux", run: async () => "unused", host: () => "builder" })).toBe("builder");
    expect(cleanDeviceName(" a\u0007b ")).toBe("ab");
    expect(cleanDeviceName("x".repeat(200))!.length).toBe(128);
    expect(cleanDeviceName("\u0001")).toBeUndefined();
  });
});
