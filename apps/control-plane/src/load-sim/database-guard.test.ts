import { describe, expect, it } from "vitest";
import { assertDisposableLoopbackDatabase, isLoopbackAddress, type LookupAll } from "./database-guard.js";

const resolvesTo = (...addresses: string[]): LookupAll => async () => addresses.map(address => ({ address }));
const unusedLookup: LookupAll = async () => { throw new Error("lookup must not run for an IP literal"); };

describe("assertDisposableLoopbackDatabase", () => {
  it("accepts loopback IP literals with an allow-listed database name", async () => {
    await expect(assertDisposableLoopbackDatabase("postgres://u:p@127.0.0.1:5432/zeros_load_sim", unusedLookup)).resolves.toBeUndefined();
    await expect(assertDisposableLoopbackDatabase("postgres://127.4.5.6:5432/zeros_load_sim_b", unusedLookup)).resolves.toBeUndefined();
    await expect(assertDisposableLoopbackDatabase("postgres://u:p@[::1]:5432/zeros_load_sim", unusedLookup)).resolves.toBeUndefined();
  });

  it("refuses query parameters, which pg applies over the URL host", async () => {
    await expect(assertDisposableLoopbackDatabase("postgres://u:p@127.0.0.1/zeros_load_sim?host=prod.example.com", unusedLookup))
      .rejects.toThrow(/must not carry query parameters/);
    await expect(assertDisposableLoopbackDatabase("postgres://u:p@127.0.0.1/zeros_load_sim?hostaddr=10.0.0.5", unusedLookup))
      .rejects.toThrow(/must not carry query parameters/);
  });

  it("refuses a DNS name that only looks like a loopback address", async () => {
    // Fixture TLD: the secrets gate allows only reserved test domains in
    // credentialed URLs; the guard must refuse the lookalike either way.
    await expect(assertDisposableLoopbackDatabase("postgres://u:p@127.attacker.test/zeros_load_sim", unusedLookup))
      .rejects.toThrow(/accepts only a loopback host/);
    await expect(assertDisposableLoopbackDatabase("postgres://u:p@127.0.0.1.attacker.test/zeros_load_sim", unusedLookup))
      .rejects.toThrow(/accepts only a loopback host/);
  });

  it("refuses non-loopback hosts", async () => {
    for (const host of ["10.0.0.5", "db.example.com", "[2001:db8::1]", "[::ffff:10.0.0.5]"])
      await expect(assertDisposableLoopbackDatabase(`postgres://u:p@${host}/zeros_load_sim`, unusedLookup))
        .rejects.toThrow(/accepts only a loopback host/);
  });

  it("checks every address localhost resolves to", async () => {
    await expect(assertDisposableLoopbackDatabase("postgres://u:p@localhost/zeros_load_sim", resolvesTo("127.0.0.1", "::1"))).resolves.toBeUndefined();
    await expect(assertDisposableLoopbackDatabase("postgres://u:p@localhost/zeros_load_sim", resolvesTo("127.0.0.1", "10.0.0.5")))
      .rejects.toThrow(/localhost must resolve only to loopback/);
    await expect(assertDisposableLoopbackDatabase("postgres://u:p@localhost/zeros_load_sim", resolvesTo()))
      .rejects.toThrow(/localhost must resolve only to loopback/);
  });

  it("refuses database names outside the disposable allow-list", async () => {
    for (const database of ["postgres", "zeros", "zeros_load", "zeros_load_sim%2Fother"])
      await expect(assertDisposableLoopbackDatabase(`postgres://u:p@127.0.0.1/${database}`, unusedLookup))
        .rejects.toThrow(/database name must match/);
  });
});

describe("isLoopbackAddress", () => {
  it("accepts only IP literals in 127.0.0.0/8 and ::1", () => {
    expect(["127.0.0.1", "127.255.0.9", "::1"].map(isLoopbackAddress)).toEqual([true, true, true]);
    expect(["127.example.com", "127.0.0.1.nip.io", "128.0.0.1", "::2", "", "localhost"].map(isLoopbackAddress))
      .toEqual([false, false, false, false, false, false]);
  });
});
