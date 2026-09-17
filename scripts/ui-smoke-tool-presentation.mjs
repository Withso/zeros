import { expect } from "@playwright/test";

export async function runToolPresentationSmoke({ page, check }) {
  const fixture = page.locator("#tool-presentation-fixture");
  const rows = fixture.locator("#tool-presentation-rows");
  const providers = ["claude", "codex", "cursor"];
  for (const provider of providers) {
    const read = rows.getByRole("button", { name: `Read ${provider}.txt`, exact: true });
    await read.click();
    await expect(read).toHaveAttribute("aria-expanded", "true");
  }
  await fixture.getByRole("button", { name: "Finish reads", exact: true }).click();
  await fixture.getByRole("button", { name: "Reload transcript", exact: true }).click();
  for (const provider of providers) {
    const read = rows.getByRole("button", { name: `Read 415 lines ${provider}.txt`, exact: true });
    await expect(read).toHaveAttribute("aria-expanded", "true");
    const detail = page.locator(`[id="${await read.getAttribute("aria-controls")}"]`);
    await expect(detail).toContainText("source line 415");
    await expect(detail).not.toContainText(/totalLines|fileSize|exitCode/);
    await read.click();
    await expect(read).toHaveAttribute("aria-expanded", "false");
  }
  check("All providers retain Read line counts and open details through result delivery and reload", true);
  const first = rows.getByRole("button", { name: "Inspect project files ls -la", exact: true });
  const second = rows.getByRole("button", {
    name: "Read the project introduction cat README.md",
    exact: true,
  });
  await expect(first).toHaveCount(1);
  await expect(second).toHaveCount(1);
  await first.click();
  await fixture
    .getByRole("button", { name: "Finish tools", exact: true })
    .click();
  await fixture
    .getByRole("button", { name: "Reload transcript", exact: true })
    .click();
  await expect(first).toHaveCount(1);
  await expect(second).toHaveCount(1);
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await first.click();

  const bash = rows.getByRole("button", {
    name: "Bash pnpm check",
    exact: true,
  });
  await expect(bash.locator("[data-tool-preview]")).toBeVisible();
  await bash.focus();
  await page.keyboard.press("Enter");
  await expect(bash).toHaveAttribute("aria-expanded", "true");
  await expect(bash.locator("[data-tool-preview]")).toHaveCount(0);
  const body = page.locator(
    `[id="${await bash.getAttribute("aria-controls")}"] [data-tool-detail]`,
  );
  await expect(body).toHaveCount(1);
  const geometry = await body.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    scrollHeight: element.scrollHeight,
    overflow: getComputedStyle(element).overflowY,
  }));
  check(
    "Expanded tool output has one 320px scroll surface",
    geometry.height <= 320 &&
      geometry.scrollHeight > 320 &&
      geometry.overflow === "auto",
  );
  await expect(body).not.toContainText(
    /Exit code:|Duration:|"command"|\/bin\/zsh/,
  );
  await expect(body.getByText("Input", { exact: true })).toHaveCount(0);
  await expect(body.getByText("Output", { exact: true })).toHaveCount(0);
  await fixture
    .getByRole("button", { name: "Append output", exact: true })
    .click();
  await expect(bash).toHaveAttribute("aria-expanded", "true");
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(body).toContainText("Late output remains visible");
  await body.focus();
  await page.keyboard.press("Home");
  await bash.click();
  await expect(bash.locator("[data-tool-preview]")).toBeVisible();

  const glob = rows.getByRole("button", { name: "Glob **/*.tsx", exact: true });
  await expect(glob).toBeDisabled();
  await expect(glob).not.toHaveAttribute("aria-expanded");
  const readA = rows.getByRole("button", { name: "Read 1 line total a.ts", exact: true });
  const readB = rows.getByRole("button", { name: "Read 1 line total b.ts", exact: true });
  await readA.click();
  await expect(rows.getByText(/One command reading 2 files/)).toHaveCount(1);
  await readB.click();
  await expect(readA).toHaveAttribute("aria-expanded", "false");
  await expect(readB).toHaveAttribute("aria-expanded", "true");
  await expect(rows.getByText(/Contents from both files/)).toHaveCount(1);
  await readB.click();
  await rows
    .getByRole("button", { name: "Bash cat private.ts", exact: true })
    .click();
  await expect(
    rows.getByText("Permission denied", { exact: true }),
  ).toBeVisible();

  const edit = fixture.locator("#tool-presentation-edit");
  await fixture.evaluate((element) => {
    document.addEventListener(
      "zeros-native-surface-overlay-intent",
      (event) => {
        element.dataset.nativeOverlayActive = String(event.detail.active);
      },
    );
  });
  const editButton = edit.getByRole("button", { name: /^Edit card.ts/ });
  const hoverPreview = page.locator(
    "[data-slot='hover-card-content'] [data-agent-diff-preview]",
  );
  await editButton.hover({ position: { x: 8, y: 8 } });
  await expect(hoverPreview).toHaveCount(1);
  await editButton.click({ position: { x: 8, y: 8 } });
  await expect(
    edit
      .locator("[data-agent-diff-preview] [data-line-type='change-addition']")
      .first(),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  await editButton.hover({ position: { x: 8, y: 8 } });
  // Cross the documented 350ms hover delay while the edit remains expanded.
  await page.waitForTimeout(450);
  await expect(hoverPreview).toHaveCount(0);
  await expect(fixture).toHaveAttribute("data-native-overlay-active", "false");
  const editGeometry = await edit
    .locator("[data-tool-detail]")
    .evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
    }));
  check(
    "Expanded edits use the same 320px cap, including path and diff",
    editGeometry.height <= 320 && editGeometry.scrollHeight > 320,
  );
  const rowColor = async (root) =>
    root
      .locator("[data-line-type='change-deletion']")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  const changes = fixture.locator("#tool-presentation-changes");
  await expect(
    changes.locator("[data-line-type='change-deletion']").first(),
  ).toBeVisible();
  check(
    "Edit and Changes share deletion-row colors",
    (await rowColor(edit)) === (await rowColor(changes)),
  );

  const probe = fixture.locator("#highlight-stream-probe");
  await expect(probe.locator(":scope > div > pre")).toHaveCount(1, {
    timeout: 15000,
  });
  await fixture
    .getByRole("button", { name: "Switch source", exact: true })
    .click();
  await expect(probe).toHaveAttribute("data-stale", "false");
  await expect(probe).toContainText('const version = "second";');
  check(
    "Tools survive settlement/reload; shared results stay singular; highlighting never paints stale source",
    true,
  );
}
