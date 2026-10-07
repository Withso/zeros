import { expect } from "@playwright/test";

async function expectFirstFocusEscape(page) {
  await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
  await page.evaluate(() => {
    window.cloudDesignFixture.firstEscapeSent = false;
    const onFocus = (event) => {
      if (event.target.getAttribute?.("role") !== "menu") return;
      document.removeEventListener("focusin", onFocus, true);
      event.target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      }));
      window.cloudDesignFixture.firstEscapeSent = true;
    };
    document.addEventListener("focusin", onFocus, true);
  });
  await page.getByRole("button", { name: "Choose Design directory" }).click();
  await expect.poll(() => page.evaluate(() => window.cloudDesignFixture.firstEscapeSent)).toBe(true);
  await expect(page.getByRole("button", { name: "Choose Design directory", includeHidden: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
}

export async function runCloudDesignDirectoriesSmoke({
  page,
  check,
  harnessBase,
}) {
  await page.goto(`${harnessBase}/harness-cloud-design-directories.html`, {
    waitUntil: "networkidle",
  });
  const settings = page.getByRole("region", {
    name: "Repository Design settings",
  });
  const row = (name) =>
    settings
      .locator("div.flex")
      .filter({ has: page.getByText(name, { exact: true }) })
      .filter({
        has: page.getByRole("button", { name: "Rename", exact: true }),
      })
      .last();
  await expect(settings.getByText("Brand", { exact: true })).toBeVisible();
  await page.evaluate(() => window.cloudDesignFixture.failNextCreate());
  await settings.getByRole("textbox", { name: "New Design folder", exact: true }).fill("Retry");
  await settings.getByRole("button", { name: "Create folder", exact: true }).click();
  await expect(page.locator("[data-sonner-toast]")).toContainText("Couldn't create the Design directory. Try again.");
  await expect(page.locator("body")).not.toContainText("Command failed:");
  await expect(page.locator("body")).not.toContainText("/srv/zeros/");
  check("cloud Design lifecycle failures use a short action toast without command paths", true);
  await settings
    .getByRole("textbox", { name: "New Design folder", exact: true })
    .fill("Campaign");
  await settings
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await expect(settings.getByText("Campaign", { exact: true })).toBeVisible();
  await row("Other")
    .getByRole("button", { name: "Use folder", exact: true })
    .click();
  await expect(
    row("Other").getByRole("button", { name: "Use folder", exact: true }),
  ).toBeDisabled();
  check(
    "cloud Design settings create and select through explicit lifecycle commands",
    true,
  );

  await settings.getByRole("button", { name: "Browse VM folders…" }).click();
  const picker = settings.getByRole("group", { name: "VM folder picker" });
  await picker.getByRole("button", { name: "Empty", exact: true }).click();
  await expect(picker.getByText("No subfolders.")).toBeVisible();
  await picker.getByRole("button", { name: "Choose this folder" }).click();
  await expect(picker.getByText(/with 2 frames/)).toBeVisible();
  await picker.getByRole("button", { name: "Register folder" }).click();
  await expect(settings.getByText("Empty", { exact: true })).toBeVisible();
  check(
    "cloud Design picker browses empty VM folders and confirms adoption",
    true,
  );

  await row("Campaign")
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  await settings
    .getByRole("textbox", { name: "Rename Design folder", exact: true })
    .fill("Studio");
  await settings.getByRole("button", { name: "Rename and commit" }).click();
  await expect(settings.getByText("Studio", { exact: true })).toBeVisible();
  await row("Studio")
    .getByRole("button", { name: "Unregister", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Unregister folder", exact: true })
    .click();
  await expect(settings.getByText("Studio", { exact: true })).toHaveCount(0);
  check(
    "cloud Design rename and registration removal require explicit confirmation",
    true,
  );

  await page.getByRole("button", { name: "Choose Design directory" }).click();
  await page.getByRole("menuitem", { name: "Manage directories…" }).click();
  const dialog = page.getByRole("dialog", { name: "Design directories" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  for (const role of ["Developer", "Prompter"]) {
    await page.getByRole("button", { name: role, exact: true }).click();
    await expect(
      settings.getByRole("button", { name: "Create folder", exact: true }),
    ).toHaveCount(0);
    await expect(
      settings.getByRole("button", { name: "Browse VM folders…" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Choose Design directory" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Other", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("menuitem", { name: "Manage directories…" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Choose Design directory" })).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  check(
    "cloud Design management is manager-only in settings and the canvas menu",
    true,
  );
  await expectFirstFocusEscape(page);
  check("the read-only cloud Design menu handles Escape at its first focus", true);
  await page.getByRole("button", { name: "Manager", exact: true }).click();
  await page.evaluate(() => window.cloudDesignFixture.holdNextBrowse());
  await settings.getByRole("button", { name: "Browse VM folders…" }).click();
  await expect
    .poll(() => page.evaluate(() => window.cloudDesignFixture.pending))
    .toBe(true);
  await settings.getByRole("combobox", { name: "Design workspace" }).click();
  await page.getByRole("option", { name: "Design VM B" }).click();
  await page.evaluate(() => window.cloudDesignFixture.release());
  await expect(
    settings.getByRole("group", { name: "VM folder picker" }),
  ).toHaveCount(0);
  await expect(settings.getByText("Campaign", { exact: true })).toHaveCount(0);
  const requests = await page.evaluate(
    () => window.cloudDesignFixture.requests,
  );
  check(
    "cloud directory requests stay scoped to cloud owners without native filesystem or generic settings calls",
    requests.every(
      (request) =>
        request.params.workspaceId.startsWith("cloud:") &&
        !["settings.write", "fs.listDir"].includes(request.op),
    ),
  );
  check(
    "a late VM folder reply cannot populate another workspace's picker",
    true,
  );
  await page.goto(`${harnessBase}/harness-cloud-design-directories.html?local=1`, {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Prompter", exact: true }).click();
  await page.evaluate(() => {
    window.cloudDesignFixture.nativeOverlayActive = false;
    document.addEventListener("zeros-native-surface-overlay-intent", (event) => {
      window.cloudDesignFixture.nativeOverlayActive = event.detail.active;
    });
  });
  await expectFirstFocusEscape(page);
  await page.getByRole("button", { name: "Prompter", exact: true }).focus();
  await expect.poll(() => page.evaluate(() => window.cloudDesignFixture.nativeOverlayActive)).toBe(false);
  check("the Local Design menu handles first-focus Escape and releases native overlays", true);
  await page.getByRole("button", { name: "Choose Design directory" }).click();
  await page.getByRole("menuitem", { name: "Other", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.cloudDesignFixture.requests
    .filter(request => request.op === "settings.write"))).toEqual([{
      op: "settings.write",
      params: {
        layer: "workspace-local", repoRoot: "/repo",
        patch: { design: { directory_id: "design_other", directory: null } },
        confirmDesignDirectoryChange: true,
      },
    }]);
  expect(await page.evaluate(() => window.cloudDesignFixture.requests.some(request =>
    ["design.selectDirectory", "design.createDirectory", "design.browseDirectories"].includes(request.op)))).toBe(false);
  check("Local canvas selection retains its settings operation and ignores cloud role changes", true);
}
