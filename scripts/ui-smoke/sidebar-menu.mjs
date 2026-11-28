import { expect } from "@playwright/test";

export const sidebarMenuTrigger = (page, options = {}) =>
  page.getByRole("button", { name: "Filter workspaces", exact: true, ...options });

export async function openSidebarSubmenu(page, name) {
  // The open View menu hides the page (and its trigger) from assistive tech;
  // reuse it instead of clicking the trigger again.
  if ((await page.getByRole("menu").count()) === 0) {
    // A row's hover card opens beside the sidebar where the menu also opens;
    // park the pointer and let it close before opening the menu.
    await page.mouse.move(900, 700);
    await expect(page.locator("[data-workspace-preview]")).toHaveCount(0);
    await sidebarMenuTrigger(page).click();
  }
  const item = page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).first();
  await item.hover();
  await expect(item).toHaveAttribute("data-state", "open");
}

/** Choosing keeps the View menu open; Escape closes it one level at a time. */
export async function closeSidebarMenu(page) {
  const menus = page.getByRole("menu");
  for (let attempt = 0; attempt < 5 && (await menus.count()) > 0; attempt += 1) {
    await page.keyboard.press("Escape");
  }
  await expect(menus).toHaveCount(0);
}

export async function selectSidebarGrouping(page, name) {
  await openSidebarSubmenu(page, "Group");
  await openSidebarSubmenu(page, "Group by");
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  await closeSidebarMenu(page);
}

export async function selectSidebarSort(page, name) {
  await openSidebarSubmenu(page, "Sort");
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  await closeSidebarMenu(page);
}
