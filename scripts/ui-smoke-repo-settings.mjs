import { expect } from "@playwright/test";

export async function runRepoSettingsSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-repo-settings.html`,
  );
  const navigation = page.locator("[data-repo-settings-navigation]");
  const tab = (name) => navigation.getByRole("tab", { name, exact: true });
  const repositories = page.getByRole("navigation", {
    name: "Fixture repositories",
  });
  const selectRepo = (name) =>
    repositories.getByRole("button", { name, exact: true }).click();
  const expectSettingsNavigation = async () => {
    await expect(navigation.getByRole("tab")).toHaveText([
      "Workspaces",
      "Environment",
      "Git",
      "Actions",
      "Files",
      "Paths",
    ]);
    await expect(
      navigation.getByRole("button", { name: /Code mode|Design mode/ }),
    ).toHaveCount(0);
    await expect(
      navigation.getByRole("tab", { name: /Directory|Preferences/ }),
    ).toHaveCount(0);
  };
  const expectNoDesignRequests = async () => {
    expect(
      await page.evaluate(() =>
        window.repoSettingsRequests.filter((op) => op.startsWith("design.")),
      ),
    ).toEqual([]);
  };

  const selections = [
    ["Local", "Actions"],
    ["Organization local", "Paths"],
    ["cloud-settings", "Environment"],
  ];
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const [name, view] of selections) {
      await selectRepo(name);
      await expect(
        page.getByRole("heading", { level: 1, name, exact: true }),
      ).toBeVisible();
      await expectSettingsNavigation();
      await tab(view).click();
      await expect(tab(view)).toHaveAttribute("aria-selected", "true");
    }
    for (const [name, view] of selections) {
      await selectRepo(name);
      await expect(tab(view)).toHaveAttribute("aria-selected", "true");
    }
    await expectNoDesignRequests();
    check(
      `Repository settings omit Design controls and retain each owner's tab in ${theme}`,
      true,
    );
  }

  await selectRepo("Local");
  await tab("Workspaces").click();
  await tab("Workspaces").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab("Environment")).toBeFocused();
  await expect(tab("Environment")).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem("zeros:ui-state:v1"));
        return saved?.repoPageViewByProject?.[saved.activeRepoId];
      }),
    )
    .toBe("environment");
  await page.reload();
  await expectSettingsNavigation();
  await expect(tab("Environment")).toHaveAttribute("aria-selected", "true");
  check(
    "Keyboard navigation and reload retain an available repository tab",
    true,
  );

  for (const [name, retired, code, expected] of [
    ["Local", "design", "actions", "Actions"],
    ["Organization local", "design-preferences", "paths", "Paths"],
    ["cloud-settings", "design-preferences", null, "Environment"],
  ]) {
    await page.evaluate(
      ({ name, retired, code }) => {
        const project = window.repoSettingsProjects.find(
          (candidate) => candidate.name === name,
        );
        const saved = JSON.parse(localStorage.getItem("zeros:ui-state:v1"));
        localStorage.setItem(
          "zeros:ui-state:v1",
          JSON.stringify({
            ...saved,
            activePage: "repo",
            activeRepoId: project.id,
            repoPageViewByProject: {
              ...saved.repoPageViewByProject,
              [project.id]: retired,
            },
            repoPageViewByModeByProject: {
              [project.id]: { code, design: retired },
            },
          }),
        );
      },
      { name, retired, code },
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { level: 1, name, exact: true }),
    ).toBeVisible();
    await expectSettingsNavigation();
    await expect(tab(expected)).toHaveAttribute("aria-selected", "true");
    await expectNoDesignRequests();
  }
  check(
    "Retired saved Design tabs recover to the same owner's Code tab or Environment",
    true,
  );

  for (const section of ["design", "design-preferences"]) {
    await tab("Actions").click();
    await page.evaluate(
      (section) => window.openRepoSettingsSection(section),
      section,
    );
    await expect(tab("Environment")).toHaveAttribute("aria-selected", "true");
    await page.evaluate(
      (section) => window.openLegacyRepoSettingsSection(section),
      section,
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Local", exact: true }),
    ).toBeVisible();
    await expect(tab("Environment")).toHaveAttribute("aria-selected", "true");
  }
  await expectNoDesignRequests();
  check(
    "Legacy repository Design sections resolve to Environment without Design operations",
    true,
  );

  // The real app settings rail keeps Back in its native title band, for every
  // owner and in both themes. Public agent controls no longer need staff access.
  for (const theme of ["dark", "light"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const [name] of selections) {
      await selectRepo(name);
      await page.evaluate(() => window.repoSettingsOpenApp());
      const sections = page.getByRole("tablist", { name: "Settings sections" });
      const back = page.getByRole("button", { name: "Back", exact: true });
      const band = back.locator("xpath=..");
      await expect(band).toHaveAttribute("data-tauri-drag-region", "true");
      const [backBox, bandBox, orgBox] = await Promise.all([
        back.boundingBox(), band.boundingBox(),
        sections.getByRole("button", { name: "Switch organization", exact: true }).boundingBox(),
      ]);
      expect(bandBox.height).toBe(40);
      expect(backBox.x).toBeGreaterThanOrEqual(bandBox.x + 80);
      expect(backBox.y).toBeGreaterThanOrEqual(bandBox.y);
      expect(backBox.y + backBox.height).toBeLessThanOrEqual(bandBox.y + bandBox.height);
      expect(orgBox.y).toBeGreaterThanOrEqual(bandBox.y + bandBox.height);
      expect(await back.evaluate(node => getComputedStyle(node).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
      for (const feature of ["Browser", "Computer use", "Simulators"])
        await expect(sections.getByRole("tab", { name: feature, exact: true })).toBeVisible();
      await expect(sections.getByRole("tab", { name: "Internal", exact: true })).toHaveCount(0);
      await back.focus();
      await page.keyboard.press("Enter");
      await expect(sections).toHaveCount(0);
    }
  }
  check("Settings Back stays beside native window controls and public agent settings are available for every owner in both themes", true);

  await selectRepo("Local");
  await page.evaluate(() => {
    window.repoSettingsSetInternal(true);
    window.repoSettingsOpenApp();
  });
  const internal = page.getByRole("tab", { name: "Internal", exact: true });
  await internal.click();
  const resourceSummary = page.getByRole("switch", { name: "Show resource summary", exact: true });
  await expect(resourceSummary).toBeChecked();
  await expect(page.getByRole("switch")).toHaveCount(2);
  await resourceSummary.click();
  await expect(resourceSummary).not.toBeChecked();
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await internal.click();
  await expect(resourceSummary).not.toBeChecked();
  await page.evaluate(() => window.repoSettingsSetInternal(false));
  await expect(internal).toHaveCount(0);
  await expect(resourceSummary).toHaveCount(0);
  check("Internal offers only Copy logs and default-on Resource summary, preserves the toggle and closes on staff revocation", true);
}
