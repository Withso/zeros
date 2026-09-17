import { expect } from "@playwright/test";

export async function runPermissionHintsSmoke({ page, harnessBase }) {
  await page.goto(`${harnessBase}/harness-permission-hints.html`, {
    waitUntil: "networkidle",
  });
  const yes = page.getByRole("button", { name: "Yes", exact: true });
  const no = page.getByRole("button", { name: /^No/ });
  const responses = () => page.evaluate(() => window.permissionResponses);
  const scenario = async (id, options = {}) => {
    await page.evaluate(
      (next) => {
        document.activeElement?.blur();
        window.setPermissionFixture(next);
      },
      { id, explicit: true, ...options },
    );
    // The production card intentionally absorbs keys already in flight for 250ms.
    await page.waitForTimeout(300);
  };
  await expect(page.getByRole("button")).toHaveCount(2);
  await expect(no).toBeFocused();
  await expect(yes).not.toContainText("↵");
  await expect(page.locator("[data-saved-policy]")).toHaveText(
    "requires decision",
  );
  await scenario("default");
  await page.keyboard.press("Enter");
  expect(await responses()).toEqual(["default:no"]);

  await scenario("deliberate");
  await page.keyboard.press("Shift+Tab");
  await expect(yes).toBeFocused();
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Meta+Enter");
  await page.keyboard.press("Control+Shift+Enter");
  expect(await responses()).toEqual([]);
  await page.keyboard.press("Enter");
  expect(await responses()).toEqual(["deliberate:yes"]);
  expect(await page.evaluate(() => window.permissionPolicies)).toBe(0);

  // A queued request replacing a focused Yes must start on No, without a
  // stale held Enter activating that replacement or the old button.
  await page.evaluate(() =>
    window.setPermissionFixture({ id: "queued", explicit: true }),
  );
  await expect(no).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await responses()).toEqual([]);
  await page.waitForTimeout(300);
  await no.press("Enter");
  expect(await responses()).toEqual(["queued:no"]);

  await scenario("held");
  await yes.focus();
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  expect(await responses()).toEqual(["held:yes"]);

  await scenario("click");
  await yes.click();
  expect(await responses()).toEqual(["click:yes"]);

  await scenario("space");
  await yes.focus();
  await page.keyboard.press("Space");
  expect(await responses()).toEqual(["space:yes"]);

  // Do not take an editor's focus when an approval arrives.
  await page.getByRole("textbox", { name: "Another editor" }).focus();
  await page.evaluate(() =>
    window.setPermissionFixture({ id: "editor", explicit: true }),
  );
  await page.waitForTimeout(300);
  await expect(page.getByRole("textbox")).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await responses()).toEqual([]);

  await scenario("inactive", { focused: false });
  await expect(no).not.toBeFocused();
  await page.keyboard.press("Enter");
  expect(await responses()).toEqual([]);
  // A retained pane can briefly retain DOM focus after losing ownership.
  // Its focused button must not activate through the browser's native default.
  await yes.focus();
  await page.keyboard.press("Enter");
  expect(await responses()).toEqual([]);
  await scenario("hidden", { hidden: true });
  await page.keyboard.press("Enter");
  expect(await responses()).toEqual([]);

  await scenario("ordinary", { explicit: false });
  await expect(page.getByRole("button")).toHaveCount(4);
  await expect(page.locator("[data-saved-policy]")).toHaveText("chat");
  await page.keyboard.press("Enter");
  expect(await responses()).toEqual(["ordinary:yes"]);
  await scenario("ordinary-chat", { explicit: false });
  await page.keyboard.press("Control+Enter");
  expect(await responses()).toEqual(["ordinary-chat:chat"]);
  expect(await page.evaluate(() => window.permissionPolicies)).toBe(1);
  console.log(
    "  [ok] explicit Yes/No approval focus, keys, policy isolation, queue swaps and ordinary approvals",
  );
}
