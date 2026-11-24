import { describe, expect, it } from "vitest";
import { egressAllowed } from "../native-alpha/egress.mjs";
import { accountNumber, inventoryClean, rehearsalRunId } from "../native-alpha/report.mjs";
import { callbackFor, stateOf } from "../native-alpha/signin.mjs";

describe("the Alpha check's egress allow-list", () => {
  it.each(["api-alpha.zeros.build:443", "app-alpha.zeros.build:443", "api.workos.com:443", "forwarder.workos.com:443",
    "some-name-alpha.authkit.app:443", "github.com:443", "api.github.com:443", "codeload.github.com:443"])("tunnels to %s", target => {
    expect(egressAllowed(target)).toBe(true);
  });
  it.each(["api.zeros.build:443", "app.zeros.build:443", "o1.ingest.sentry.io:443", "static.cloudflareinsights.com:443", "us.i.posthog.com:443",
    "api-alpha.zeros.build:80", "github.com:22", "authkit.app:443", "evil-authkit.app:443", "api.workos.com.example:443", "not a target"])("refuses %s", target => {
    expect(egressAllowed(target)).toBe(false);
  });
});

describe("the Alpha check's account", () => {
  it("takes a numbered test user, default 9 in the script", () => {
    expect(accountNumber("9")).toBe(9);
    expect(accountNumber(" 10 ")).toBe(10);
  });
  it.each(["owner", "0", "11", "2", "3", "", "9a"])("refuses %s (never the owner, never the rehearsal's own 2 and 3)", value => {
    expect(() => accountNumber(value)).toThrow();
  });
});

describe("reading the rehearsal's output", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  it("finds the run id on the rehearsal's first line", () => {
    expect(rehearsalRunId(`[rehearse] run ${id} prefix zr-11111111- route personal\n[rehearse] stage setup: ok`)).toBe(id);
    expect(rehearsalRunId("[rehearse] stage setup: failed switch undeclared_personal")).toBeNull();
  });
  it("calls a clean-up clean only when the inventory says so and nothing failed", () => {
    expect(inventoryClean("[rehearse] inventory workspaces 0\n[rehearse] inventory projects 0\n[rehearse] inventory clean\n")).toBe(true);
    expect(inventoryClean("[rehearse] inventory workspaces 1\n")).toBe(false);
    expect(inventoryClean("[rehearse] cleanup workspace: failed\n[rehearse] inventory clean\n")).toBe(false);
    expect(inventoryClean("[rehearse] inventory clean\nfailed: exit 1")).toBe(false);
  });
});

describe("the sign-in callback", () => {
  const state = `zeros-dev.${"s".repeat(43)}`;
  it("returns the hosted page's link to the app only for the state the app sent", () => {
    const html = `<a href="zeros-dev://auth/callback#code=01ABC&amp;state=${state}">Open Zeros</a>`;
    expect(callbackFor(html, state)).toBe(`zeros-dev://auth/callback#code=01ABC&state=${state}`);
    expect(callbackFor(html, `zeros-dev.${"t".repeat(43)}`)).toBeNull();
    expect(callbackFor(`<a href="zeros-dev://auth/callback#state=${state}">`, state)).toBeNull();
    expect(callbackFor(`<a href="zeros://auth/callback#code=1&state=${state}">`, state)).toBeNull();
  });
  it("reads the PKCE state from the authorize URL", () => {
    expect(stateOf(`https://app-alpha.zeros.build/auth/desktop?state=${state}&code_challenge=x`)).toBe(state);
    expect(stateOf("not a url")).toBeNull();
  });
});

describe("the project page's build status", () => {
  it("is the line after the Cloud build heading and its description", async () => {
    const { buildLabel } = await import("../native-alpha/checks.mjs");
    const page = (label: string) => `Where it runs\nThis Mac\n\nCloud build\nThe build new cloud workspaces start from.\n\n${label}\nNew workspaces clone directly.`;
    expect(buildLabel(page("Getting ready…"))).toBe("Getting ready");
    expect(buildLabel(page("Ready"))).toBe("Ready");
    expect(buildLabel(page("Update failed"))).toBe("Update failed");
    expect(buildLabel(page("Something else"))).toBe("?");
    expect(buildLabel("no section here")).toBe("?");
  });
});
