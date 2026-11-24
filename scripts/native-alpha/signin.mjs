// The app's own sign-in, completed the way a person would in their browser: the authorize URL the app asked the system
// browser to open is loaded in a separate headless Chromium (behind the run's egress guard), AuthKit's hosted page is
// filled with the numbered test user's email and password, a passkey offer is skipped ("Skip for now" only, so the
// account's settings never change), and the hosted callback's link back to the app is returned for the check to hand
// to the app as a second instance. The password lives only in this process's memory and that page's field: it is never
// logged, put in a report or screenshotted (nothing of this browser is captured at all).
import { chromium } from "@playwright/test";

/** The callback link a dev desktop accepts: zeros-dev://auth/callback with the state the app sent. */
export function callbackFor(html, state, scheme = "zeros-dev") {
  const pattern = new RegExp(`${scheme}://auth/callback[^"'<\\s]*`);
  const raw = pattern.exec(String(html ?? ""))?.[0]?.replace(/&amp;/g, "&");
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const values = new URLSearchParams(url.hash.replace(/^#/, "") || url.search.replace(/^\?/, ""));
  return values.get("state") === state && values.get("code") ? raw : null;
}

/** The PKCE state in an authorize URL at Alpha's /auth/desktop start, or the WorkOS authorize URL it leads to. */
export function stateOf(authorizeUrl) {
  try { return new URL(authorizeUrl).searchParams.get("state"); } catch { return null; }
}

export async function completeHostedSignIn({ authorizeUrl, email, password, proxyUrl, timeoutMs = 90_000, scheme = "zeros-dev" }) {
  const state = stateOf(authorizeUrl);
  if (!state?.startsWith(`${scheme}.`)) throw new Error("The app's sign-in did not ask for a dev desktop callback.");
  const browser = await chromium.launch({ headless: true, proxy: { server: proxyUrl } });
  try {
    const page = await browser.newPage();
    const deadline = Date.now() + timeoutMs;
    await page.goto(authorizeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const emailField = page.locator("input[type=email], input[name=email]").first();
    await emailField.waitFor({ timeout: timeoutMs });
    await emailField.fill(email);
    await page.locator("button[type=submit]").first().click();
    const passwordField = page.locator("input[type=password]").first();
    await passwordField.waitFor({ timeout: Math.max(1, deadline - Date.now()) });
    await passwordField.fill(password);
    await page.locator("button[type=submit]").first().click();
    let skipped = false;
    while (Date.now() < deadline) {
      const link = callbackFor(await page.content().catch(() => ""), state, scheme);
      if (link) return { link, passkeyOfferSkipped: skipped };
      const skip = page.getByRole("button", { name: "Skip for now", exact: true });
      if (await skip.isVisible().catch(() => false)) { await skip.click(); skipped = true; }
      await page.waitForTimeout(500);
    }
    throw new Error("AuthKit's hosted sign-in did not reach the app's callback in time.");
  } finally {
    await browser.close();
  }
}
