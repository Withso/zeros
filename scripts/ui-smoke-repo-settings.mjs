import { join } from "node:path";
import { expect } from "@playwright/test";
import { runCloudEnvironmentSmoke } from "./ui-smoke-cloud-environment.mjs";

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
    await selectRepo("Local");
    await tab("Actions").click();
    await page.evaluate(
      (section) => window.openRepoSettingsSection(section),
      section,
    );
    await expect(tab("Environment")).toHaveAttribute("aria-selected", "true");
    // Dev runs unified-workspaces: a saved repository selection opens its
    // joined project page in Settings instead of the repository page.
    await page.evaluate(
      (section) => window.openLegacyRepoSettingsSection(section),
      section,
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Local", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-project-page]")).toBeVisible();
    await expect(
      page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab", { name: "Local", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
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
      // Dev runs the unified rail: Computer use, Browser and Simulators are
      // Personal device pages for every owner.
      // An organization adds its own General after the Personal one.
      for (const feature of ["General", "Computer use", "Browser", "Simulators"])
        await expect(sections.getByRole("tab", { name: feature, exact: true }).first()).toBeVisible();
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
  // The recorded Design canvas is an experiment staff opt into.
  await expect(page.getByRole("switch", { name: "Draw Design frames from recordings", exact: true })).not.toBeChecked();
  await expect(page.getByRole("switch")).toHaveCount(3);
  await resourceSummary.click();
  await expect(resourceSummary).not.toBeChecked();
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await internal.click();
  await expect(resourceSummary).not.toBeChecked();
  await page.evaluate(() => window.repoSettingsSetInternal(false));
  await expect(internal).toHaveCount(0);
  await expect(resourceSummary).toHaveCount(0);
  check("Internal offers Copy logs, default-on Resource summary and default-off Recorded Design canvas, preserves the toggle and closes on staff revocation", true);

  // A joined project page as an owner and a member of an organization with the
  // repository in both places, and for a repository only on the Cloud Computer.
  const shots = process.env.ZEROS_SMOKE_SHOTS;
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  const projectPage = page.locator("[data-project-page]");
  const text = (value) => projectPage.getByText(value, { exact: true });
  const button = (name) => projectPage.getByRole("button", { name, exact: true });
  const sideHeadings = () => projectPage.locator("h3").allTextContents();
  for (const state of ["both-admin", "both-member", "cloud-only"]) {
    await page.evaluate((state) => window.repoSettingsOpenProject(state), state);
    const key = state === "cloud-only" ? "github:example/cloud-only" : "github:example/cloud-settings";
    await expect(projectPage).toHaveAttribute("data-project-page", key);
    await expect(projectPage.locator("h2")).toHaveText(state === "cloud-only"
      ? ["Where it runs", "Scripts", "Git", "Environment"]
      : ["Where it runs", "Scripts", "Git", "Environment", "Run actions", "Actions", "Files to copy", "Folder"]);
    await expect(text("On the Cloud Computer")).toBeVisible();
    if (shots) await page.screenshot({ path: join(shots, `p3-${state}.png`), fullPage: true, animations: "disabled" });
    await expect(button("Add to cloud")).toHaveCount(0);
    if (state === "cloud-only") {
      await expect(text("Not on this Mac")).toBeVisible();
      await expect(text("/fixture/cloud-settings")).toHaveCount(0);
      await expect(text("Managed by admins")).toHaveCount(0);
      expect(await sideHeadings()).not.toContain("This Mac");
      await button("Clone to this Mac").click();
      expect(await page.evaluate(() => window.repoSettingsCloneRequests.at(-1)))
        .toEqual({ placement: "local", url: "https://github.com/example/cloud-only.git" });
    } else {
      await expect(text("/fixture/cloud-settings").first()).toBeVisible();
      await expect(text("Not on this Mac")).toHaveCount(0);
      await expect(button("Clone to this Mac")).toHaveCount(0);
      const admin = state === "both-admin";
      // Owners edit both sides under This Mac and Cloud; members read the cloud side as rows.
      const headings = await sideHeadings();
      expect(headings).toContain("This Mac");
      expect(headings.includes("Cloud")).toBe(admin);
      await expect(text("Managed by admins")).toHaveCount(admin ? 0 : 2);
      await expect(projectPage.getByRole("textbox", { name: "example/cloud-settings branch" })).toHaveCount(admin ? 1 : 0);
      await expect(projectPage.getByRole("textbox", { name: "example/cloud-settings setup command" })).toHaveCount(admin ? 1 : 0);
    }
  }
  check("A joined project page shows both places to owners, a read-only cloud side to members, and Clone to this Mac for a cloud-only repository", true);
  await runCloudEnvironmentSmoke({ page, check });
}
