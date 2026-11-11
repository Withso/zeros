import { expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const org = "22222222-2222-4222-8222-222222222222", workspace = "33333333-3333-4333-8333-333333333333";
const me = "11111111-1111-4111-8111-111111111111", alex = "44444444-4444-4444-8444-444444444444", sam = "55555555-5555-4555-8555-555555555555";
const members = [
  { id: me, email: "fixture@example.test", display_name: "Fixture", avatar_url: null, role: "member" },
  { id: alex, email: "alex@example.test", display_name: "Alex Rivera", avatar_url: null, role: "admin" },
  { id: sam, email: "sam@example.test", display_name: "Sam Lee", avatar_url: null, role: "member" },
  { id: "66666666-6666-4666-8666-666666666666", email: "no-workspaces@example.test", display_name: "Jo Park", avatar_url: null, role: "member" },
];

/** Team sharing phase 1 on production components: Home's By filter and the
 * Team list from the keyboard, then a teammate's workspace as a reader
 * (presence from the events stream, Follow and Pin, the read-only bar), in
 * dark and light. Every control-plane route is intercepted. PNGs are written
 * only when ZEROS_SMOKE_SHOTS names a directory. */
export async function runTeamSharingSmoke({ page, harnessBase, check }) {
  const base = `${new URL(harnessBase).origin}/apps/desktop/src/renderer/harnesses/harness-team-sharing.html`;
  const shots = process.env.ZEROS_SMOKE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const shoot = async (locator, name) => { if (shots) await locator.screenshot({ path: join(shots, `${name}.png`) }); };
  const token = name => page.evaluate(variable => {
    const probe = document.createElement("div");
    probe.style.color = `var(${variable})`; document.body.append(probe);
    const value = getComputedStyle(probe).color; probe.remove(); return value;
  }, name);
  const color = (locator, property) => locator.evaluate((node, key) => getComputedStyle(node)[key], property);

  const posts = [], sharingHeaders = [];
  const api = "https://api.example.test";
  // The events stream's ready re-reads the document; keep the fixture's copy.
  await page.route(`${api}/v1/cloud-v2/workspaces/${workspace}`, route => route.abort());
  await page.route(`${api}/v1/organizations/${org}/members`, route => route.fulfill({ json: { members } }));
  await page.route(`${api}/v1/cloud-v2/workspaces/${workspace}/events`, route => {
    sharingHeaders.push(route.request().headers()["x-zeros-team-sharing"]);
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" },
      body: `event: ready\ndata: {"teamSharing":1}\n\nevent: presence\ndata: {"workspaceId":"${workspace}","userIds":["${me}","${sam}"],"total":2}\n\nevent: heartbeat\ndata: {}\n\n` });
  });
  await page.route(`${api}/v1/cloud-v2/workspaces/${workspace}/*`, async route => {
    const action = new URL(route.request().url()).pathname.split("/").pop();
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(action); sharingHeaders.push(route.request().headers()["x-zeros-team-sharing"]);
    await route.fulfill({ json: action === "follow" || action === "unfollow" ? { following: action === "follow" } : { pinned: action === "pin" } });
  });
  try {
    for (const theme of ["dark", "light"]) {
      posts.length = 0;
      await page.goto(`${base}?theme=${theme}`);
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);

      // The Team list names every member, the viewer first, including someone with no workspaces.
      const team = page.getByRole("group", { name: "Team" });
      await expect.poll(() => team.getByRole("button").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))))
        .toEqual(["Workspaces by you", "Workspaces by Alex Rivera", "Workspaces by Jo Park", "Workspaces by Sam Lee"]);
      await expect(team.getByRole("button", { name: "Workspaces by you" })).toContainText("Fixture (you)");
      const list = page.getByRole("list", { name: "Workspaces" });
      await expect(list.getByRole("listitem")).toHaveCount(3);

      // By from the keyboard.
      const by = page.getByRole("button", { name: "Workspaces by", exact: true });
      await expect(by).toHaveText(/By anyone/);
      await by.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitemradio")).toHaveText(["By anyone", "By me", "Alex Rivera", "Jo Park", "Sam Lee"]);
      await menu.getByRole("menuitemradio", { name: "Alex Rivera" }).focus();
      await page.keyboard.press("Enter");
      await expect(by).toHaveText(/By Alex Rivera/);
      await expect(list.getByRole("listitem")).toHaveText(["Alex's workspace"]);

      // A person in the Team list opens Home filtered to them.
      await team.getByRole("button", { name: "Workspaces by Sam Lee" }).focus();
      await page.keyboard.press("Enter");
      await expect(by).toHaveText(/By Sam Lee/);
      await expect(list.getByRole("listitem")).toHaveText(["Sam's workspace"]);
      expect(await page.evaluate(() => window.__teamSharingFixture.homeOpens())).toBe(1);
      await expect(team.getByRole("button", { name: "Workspaces by Sam Lee" })).toHaveAttribute("data-state", "active");
      check(`Home's By filter and the Team list (every member, from the keyboard) narrow Home to one person in ${theme}`, true);

      // The reader's header: presence from the events stream, Follow and Pin from the keyboard, the read-only bar.
      const reader = page.getByRole("region", { name: "Reader" });
      await expect(reader.getByRole("img", { name: "Also viewing: Sam Lee" })).toBeVisible();
      const bar = reader.locator("[data-team-sharing-read-only]");
      await expect(bar).toHaveText("Read only. Alex Rivera runs this workspace.");
      expect(await color(bar.locator("p"), "color")).toBe(await token("--fg2"));
      const follow = reader.getByRole("button", { name: "Follow" });
      await follow.focus();
      expect(await follow.evaluate(node => node.matches(":focus-visible"))).toBe(true);
      await page.keyboard.press("Enter");
      await expect(reader.getByRole("button", { name: "Following" })).toHaveAttribute("aria-pressed", "true");
      const pin = reader.getByRole("button", { name: "Pin workspace" });
      await pin.focus();
      await page.keyboard.press("Enter");
      await expect(reader.getByRole("button", { name: "Unpin workspace" })).toHaveAttribute("aria-pressed", "true");
      expect(posts).toEqual(["follow", "pin"]);
      // No composer, terminal or Git control is offered to a reader.
      await expect(reader.getByRole("textbox")).toHaveCount(0);
      await shoot(page.locator("main"), `team-sharing-${theme}`);
      check(`A reader sees presence, the read-only bar on token colors, and follows and pins from the keyboard in ${theme}`, true);
    }
    expect(sharingHeaders.length).toBeGreaterThan(0);
    expect(sharingHeaders.every(value => value === "1")).toBe(true);
    check("Every Team sharing request carries the opt-in header", true);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
}
