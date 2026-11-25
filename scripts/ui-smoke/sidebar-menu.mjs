import { expect } from "@playwright/test";

export const sidebarMenuTrigger = (page, options = {}) =>
  page.getByRole("button", { name: "Filter workspaces", exact: true, ...options });

export async function openSidebarSubmenu(page, name) {
  await sidebarMenuTrigger(page).click();
  const item = page.getByRole("menuitem", { name: new RegExp(`^${name}`) });
  await item.hover();
  await expect(item).toHaveAttribute("data-state", "open");
}

export async function selectSidebarGrouping(page, name) {
  await openSidebarSubmenu(page, "Group");
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}

export async function selectSidebarSort(page, name) {
  await openSidebarSubmenu(page, "Sort");
  await page.getByRole("menuitemradio", { name, exact: true }).click();
}
