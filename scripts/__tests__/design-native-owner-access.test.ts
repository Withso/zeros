import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { createRequire } from "node:module";

const { waitForNativeOwnerAccess, selectNativeOwner } = createRequire(import.meta.url)("../design-native-owner-access.mjs");
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

it.each(["signed-out", "no-membership", "member"])("checks normal %s authorization before gated bridge readiness", async state => {
  const page = await browser.newPage();
  try {
    await page.route("http://owner-fixture.test/**", async route => {
      const url = route.request().url();
      const body = url.endsWith("auth-store.ts") ? `export async function getSession() { globalThis.fixture.calls.push("auth"); return ${state === "signed-out" ? "null" : '{ access_token: "synthetic-test-value", user: { name: "fixture" } }'}; }`
        : url.endsWith("team-store.ts") ? `export async function refreshTeams() { globalThis.fixture.calls.push("membership"); return { organizations: [{ id: "personal", isPersonal: true }${state === "member" ? ', { id: "organization", isPersonal: false }' : ''}] }; }`
        : url.endsWith("active-bridge.ts") ? `export function getActiveBridge() { globalThis.fixture.calls.push("bridge"); return { status: globalThis.fixture.calls.includes("membership") ? "connected" : "disconnected" }; }`
        : `<script>globalThis.__ZEROS_NATIVE__ = { localDevelopment: false }; globalThis.fixture = { calls: [] };</script>`;
      await route.fulfill({ contentType: url.endsWith(".ts") ? "text/javascript" : "text/html", body });
    });
    await page.goto("http://owner-fixture.test/");
    const access = await waitForNativeOwnerAccess(page, 3_000);
    expect(access).toEqual({ signedIn: state !== "signed-out", organizationId: state === "member" ? "organization" : null,
      blocked: state === "member" ? null : state === "signed-out"
        ? "The primary Alpha Dev profile has no usable signed-in session."
        : "The normal Dev account returned no organization membership." });
    expect(await page.evaluate(() => (globalThis as any).fixture.calls)).toEqual(
      state === "member" ? ["auth", "membership", "bridge"] : state === "signed-out" ? ["auth"] : ["auth", "membership"]);
  } finally { await page.close(); }
});

it("rejects account-free Local mode before claiming organization access", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<script>globalThis.__ZEROS_NATIVE__ = {localDevelopment:true};</script>');
    await expect(waitForNativeOwnerAccess(page, 100)).rejects.toThrow("Organization qualification requires ordinary Dev authorization");
  } finally { await page.close(); }
});

it.each(["confirmed", "fallback", "not-a-member"])("requires exact %s owner publication before workspace navigation", async state => {
  const page = await browser.newPage();
  try {
    await page.route("http://owner-switch.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname.endsWith("team-store.ts") ? `
        export function getTeamStoreState(){return {me:{organizations:${state === "not-a-member" ? "[]" : '[{id:"organization",isPersonal:false}]'}}};}
        export function getActiveOrganizationSnapshot(){return {id:globalThis.owner};}
      ` : pathname.endsWith("active-team.ts") ? `
        export function setActiveOrganizationSelection(id){globalThis.selections++;globalThis.owner=${state === "fallback" ? '"local-personal"' : "id"};}
      ` : `<script>globalThis.owner="local-personal";globalThis.selections=0;</script>`;
      await route.fulfill({ contentType: pathname.endsWith(".ts") ? "text/javascript" : "text/html", body });
    });
    await page.goto("http://owner-switch.test/");
    const selected = selectNativeOwner(page, { organizationId: "organization" }, 200);
    if (state === "confirmed") {
      await selected;
      expect(await page.evaluate(() => (globalThis as any).owner)).toBe("organization");
      await selectNativeOwner(page, { organizationId: null }, 200);
      expect(await page.evaluate(() => (globalThis as any).owner)).toBe("local-personal");
    } else {
      await expect(selected).rejects.toThrow(state === "fallback" ? "Native fixture owner did not become active" : "no longer has normal membership");
    }
    expect(await page.evaluate(() => (globalThis as any).selections)).toBe(state === "confirmed" ? 2 : state === "fallback" ? 1 : 0);
  } finally { await page.close(); }
});
