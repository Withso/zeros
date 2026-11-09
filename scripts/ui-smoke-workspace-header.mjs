import { expect } from "@playwright/test";

/** 2026-11-09: the workspace header reads name first, then where the workspace
 *  lives (a laptop for every Local workspace, a cloud for cloud) as one ghost
 *  control: no fill at rest, bg2-highlight on hover and while its details are
 *  open, in both themes. It opens the Local details (branch, folder and Local)
 *  or the cloud details, which close on Escape and when the workspace page is
 *  hidden, and stay closed when it returns. */
export async function runWorkspaceHeaderSmoke({ page, check, harnessBase }) {
  const harness = `${harnessBase}/harness-app-sidebar.html?shortcuts&settings`;
  await page.goto(harness, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(harness, { waitUntil: "networkidle" });
  await page.keyboard.press("Meta+Digit1");
  const header = page.getByLabel("Workspace header", { exact: true });
  const identity = header.locator("[data-workspace-identity]");
  const nameText = identity.locator("[data-workspace-name]");
  await expect(identity).toHaveCount(1);
  const state = () => page.evaluate(() => window.appSidebarState());
  const away = async () => {
    const box = await page.locator(".zeros-agent-messages").filter({ visible: true }).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };
  const fill = () => identity.evaluate(node => getComputedStyle(node).backgroundColor);
  const token = name => page.evaluate(name => {
    const probe = document.createElement("div");
    probe.style.background = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, name);
  const nameThenIcon = async placement => {
    const [name, icon] = await Promise.all([
      nameText.boundingBox(),
      identity.locator(`[data-workspace-placement="${placement}"]`).boundingBox(),
    ]);
    return name.x + name.width <= icon.x && Math.abs(name.y + name.height / 2 - (icon.y + icon.height / 2)) <= 1;
  };
  const ghost = async () => {
    for (const theme of ["dark", "light"]) {
      await page.evaluate(theme => document.documentElement.setAttribute("data-theme", theme), theme);
      await away();
      await expect.poll(fill, { message: `${theme} rest` }).toBe("rgba(0, 0, 0, 0)");
      await identity.hover();
      const highlight = await token("--bg2-highlight");
      await expect.poll(fill, { message: `${theme} hover` }).toBe(highlight);
    }
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await away();
    await expect.poll(fill).toBe("rgba(0, 0, 0, 0)");
  };

  // Local: the name, then the laptop.
  const { folder } = await state();
  const name = (await nameText.textContent()).trim();
  const branch = `zeros/${folder.split("/").pop()}`;
  await expect(identity.locator(".lucide-laptop")).toBeVisible();
  expect(await nameThenIcon("local")).toBe(true);
  await expect(identity).toHaveAccessibleName(`${name}, Local workspace`);
  const [headerBox, identityBox] = await Promise.all([header.boundingBox(), identity.boundingBox()]);
  expect(identityBox.height).toBe(28);
  expect(Math.round(identityBox.y + identityBox.height / 2)).toBe(Math.round(headerBox.y + headerBox.height / 2));
  await ghost();
  check("Workspace header: a Local workspace reads name then laptop, one 28px ghost control filled only on hover, in both themes", true);

  const details = page.getByRole("dialog", { name: "Local workspace details", exact: true });
  await identity.click();
  await expect(details).toBeVisible();
  await expect(identity).toHaveAttribute("aria-expanded", "true");
  await away();
  await expect.poll(fill).toBe(await token("--bg2-highlight"));
  await expect(details.getByText(name, { exact: true })).toBeVisible();
  await expect(details.getByText(branch, { exact: true })).toBeVisible();
  await expect(details.getByText(folder, { exact: true })).toBeVisible();
  await expect(details.getByText("Local", { exact: true })).toBeVisible();
  await expect(details.locator(".lucide-git-branch")).toBeVisible();
  await expect(details.locator(".lucide-folder")).toBeVisible();
  const [popupBox, triggerBox] = await Promise.all([details.boundingBox(), identity.boundingBox()]);
  expect(Math.abs(popupBox.x - triggerBox.x)).toBeLessThanOrEqual(1);
  expect(popupBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height + 5);
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(identity).toHaveAttribute("aria-expanded", "false");
  check("Workspace header: the Local name opens its branch, folder and Local, holds its fill while open and closes on Escape", true);

  // This harness unmounts the chat on Settings; the shell keeps it mounted,
  // inert and invisible, which workspace-details-open.test.ts covers.
  await identity.click();
  await expect(details).toBeVisible();
  await page.evaluate(() => window.appSidebarNavigate("settings"));
  await expect(details).toHaveCount(0);
  await page.evaluate(() => window.appSidebarNavigate("workspace"));
  await expect(identity).toBeVisible();
  await expect(identity).toHaveAttribute("aria-expanded", "false");
  await expect(details).toHaveCount(0);
  check("Workspace header: hiding the workspace page closes its details, and they stay closed when it returns", true);

  // Cloud: the same control with a cloud, opening the cloud details.
  const cloud = await page.evaluate(() => window.appSidebarSeedCloud());
  await page.getByRole("button", { name: "Home", exact: true }).focus();
  await page.keyboard.press("Meta+Digit1");
  await expect.poll(async () => (await state()).folder).toBe(cloud.keys[0]);
  await expect(nameText).toHaveText("cloud-one");
  await expect(identity.locator(".lucide-cloud")).toBeVisible();
  await expect(identity.locator(".lucide-laptop")).toHaveCount(0);
  expect(await nameThenIcon("cloud")).toBe(true);
  await expect(identity).toHaveAccessibleName("cloud-one, Cloud workspace");
  await ghost();
  const cloudDetails = page.getByRole("dialog", { name: "Cloud workspace details", exact: true });
  await identity.click();
  await expect(cloudDetails).toBeVisible();
  await expect(cloudDetails.getByText("cloud-one", { exact: true })).toBeVisible();
  await expect(cloudDetails.getByText("example/cloud-one", { exact: true })).toBeVisible();
  await expect(cloudDetails.getByRole("button", { name: "Start workspace", exact: true })).toBeVisible();
  await away();
  await expect.poll(fill).toBe(await token("--bg2-highlight"));
  await page.keyboard.press("Escape");
  await expect(cloudDetails).toHaveCount(0);
  check("Workspace header: a cloud workspace reads name then cloud and opens the same cloud details", true);

  await page.evaluate(() => window.appSidebarSelectOwner(null));
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}
