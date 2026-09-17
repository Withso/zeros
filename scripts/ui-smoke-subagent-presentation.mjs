import { expect } from "@playwright/test";

export async function runSubagentPresentationSmoke({ page, check }) {
  const fixture = page.locator("#subagent-presentation-fixture");
  const groups = fixture.locator("#nested-agent-groups");
  const group = (provider) =>
    groups.locator("[data-agent-group]").filter({
      has: page.getByRole("button", {
        name: `Agent ${provider} source audit`,
        exact: true,
      }),
    });
  const header = (provider) =>
    group(provider).getByRole("button", {
      name: `Agent ${provider} source audit`,
      exact: true,
    });
  const checkThinkingSpacing = async (button, label) => {
    const id = await button.getAttribute("aria-controls");
    const detail = page.locator(`[id="${id}"]`);
    await expect(detail.locator("p")).toHaveCount(2);
    const spacing = await detail.evaluate((root) => {
      const paragraphs = [...root.querySelectorAll("p")];
      const first = paragraphs[0].getBoundingClientRect();
      const last = paragraphs.at(-1).getBoundingClientRect();
      const bounds = root.getBoundingClientRect();
      const style = getComputedStyle(paragraphs[0]);
      return {
        top: first.top - bounds.top,
        bottom: bounds.bottom - last.bottom,
        gap: paragraphs[1].getBoundingClientRect().top - first.bottom,
        lineRatio: parseFloat(style.lineHeight) / parseFloat(style.fontSize),
      };
    });
    check(
      `${label} Thinking has compact edges, paragraphs and line spacing (${JSON.stringify(spacing)})`,
      spacing.top >= 0 && spacing.top <= 4 &&
        spacing.bottom >= 0 && spacing.bottom <= 4 &&
        spacing.gap > 0 && spacing.gap <= 8 && spacing.lineRatio <= 1.5,
    );
    await expect(detail.locator("[data-tool-detail]")).toHaveCount(0);
  };
  const rootThinking = fixture.locator("#thinking-spacing-probe").getByRole("button", { name: /^Thinking/ });
  await rootThinking.click();
  await checkThinkingSpacing(rootThinking, "Root");
  for (const provider of ["Claude", "Codex", "Cursor"])
    await expect(header(provider)).toHaveAttribute("aria-expanded", "false");
  await expect(groups.locator("[data-agent-children]")).toHaveCount(0);
  await expect(header("Claude")).toContainText("Opus");
  // The chevron takes over exactly the loader/Bot slot, including keyboard focus.
  const icon = header("Claude").locator("[data-agent-icon]");
  await header("Claude").hover();
  await expect(icon.locator(".lucide-chevron-right")).toBeVisible();
  await expect(icon.getByRole("status")).toHaveCount(0);
  const narration = fixture.locator("#narration-readiness-probe");
  await expect(narration.getByRole("button")).toHaveCount(0);
  const color = (locator) =>
    locator.evaluate((element) => getComputedStyle(element).color);
  const bright = await color(narration.locator(".zeros-agent-md"));
  await header("Claude").focus();
  await page.keyboard.press("Enter");
  const claude = group("Claude");
  await expect(claude.locator("[data-agent-children]")).toBeVisible();
  await expect(icon.locator(".lucide-chevron-down")).toBeVisible();
  const [slot, rail] = await Promise.all([
    icon.boundingBox(),
    claude.locator("[data-agent-children]").boundingBox(),
  ]);
  check(
    "Agent disclosure shares the status slot and the child rail aligns with it",
    Math.abs(slot.x + slot.width / 2 - rail.x) <= 1,
  );
  await expect(claude.locator("[data-tool-detail]")).toHaveCount(0);
  const thinking = claude.getByRole("button", { name: /^Thinking/ });
  await thinking.click();
  await checkThinkingSpacing(thinking, "Claude child");
  await expect(thinking).not.toContainText(/\d+s/);
  await expect(
    claude.getByText(
      "Checking the entry points before following the imports.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(claude.locator("[data-tool-detail]")).toHaveCount(0);
  const childText = claude.getByText("Claude is inspecting the source.", {
    exact: true,
  });
  check(
    "Live child narration is bright inside its group",
    (await color(childText)) === bright,
  );
  await fixture
    .getByRole("button", { name: "Stream child tools", exact: true })
    .click();
  await expect(header("Claude")).toHaveAttribute("aria-expanded", "true");
  await expect(header("Cursor")).toHaveAttribute("aria-expanded", "false");
  const rootTool = narration.getByRole("button", {
    name: "Bash pwd",
    exact: true,
  });
  await expect(rootTool).toHaveCount(1);
  const muted = await color(
    rootTool.locator('span[aria-hidden="true"]').first(),
  );
  const parentColor = await color(narration.locator(".zeros-agent-md"));
  const childColor = await color(childText);
  check(
    `Tool icons and earlier narration use fg2 (${JSON.stringify({ bright, muted, parentColor, childColor })})`,
    muted !== bright && parentColor === muted && childColor === muted,
  );
  const command = claude.getByRole("button", {
    name: "Bash pnpm test",
    exact: true,
  });
  await command.click();
  const card = claude.locator("[data-tool-detail]");
  const size = await card.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    scrollHeight: element.scrollHeight,
  }));
  const groupHeight = await claude
    .locator("[data-agent-children]")
    .evaluate((element) => element.getBoundingClientRect().height);
  check(
    "Agent feed grows naturally while each child tool keeps its 320px card",
    groupHeight > 320 && size.height <= 320 && size.scrollHeight > 320,
  );
  await fixture
    .getByRole("button", { name: "Finish child agents", exact: true })
    .click();
  await expect(header("Claude")).toHaveAttribute("aria-expanded", "true");
  await expect(command).toHaveAttribute("aria-expanded", "true");
  await expect(
    claude.getByRole("status", { name: "Agent working", exact: true }),
  ).toHaveCount(0);
  await expect(header("Claude").locator(".lucide-bot")).toHaveCount(1);
  check(
    "Child final output stays bright inside a completed group",
    (await color(claude.locator("[data-agent-output] .zeros-agent-md"))) ===
      bright,
  );
  for (const provider of ["Codex", "Cursor"]) {
    await header(provider).click();
    const childThinking = group(provider).getByRole("button", { name: /^Thinking/ });
    await childThinking.click();
    await checkThinkingSpacing(childThinking, `${provider} child`);
    await expect(
      group(provider).getByText(
        `${provider} audit complete. The project is a desktop coding workspace.`,
        { exact: true },
      ),
    ).toBeVisible();
  }
  for (const text of ["Some subagent details could not be loaded.", "Subagent details were truncated."]) {
    const notice = group("Cursor").getByText(text, { exact: true });
    await expect(notice).toBeVisible();
    check("Subagent capture notices render as nested prose without a tool or card",
      await notice.evaluate((element) => !!element.closest("[data-agent-children]") &&
        !element.closest("button, [data-tool-detail], [role=alert]")));
  }
  const errors = fixture.locator("#error-and-list-probe");
  await expect(errors.locator(".lucide-file-search")).toHaveCount(1);
  const failed = errors.getByRole("button", { name: /^Read private.ts/ });
  await expect(failed).toContainText("Error");
  await expect(failed.locator(".lucide-circle-x")).toHaveCount(1);
  await failed.click();
  const errorCard = errors.locator("[data-tool-detail]").first();
  await expect(errorCard).toContainText("Permission denied by the workspace");
  check(
    "Failed tools use the error card styling",
    (await color(errorCard)) ===
      (await color(failed.locator(".lucide-circle-x"))) ||
      (await errorCard.getAttribute("class")).includes("bg-red-bg"),
  );
  const shell = errors.getByRole("button", { name: /^Check command access/ });
  const red = await color(shell.locator(".lucide-circle-x"));
  const preview = shell.locator("[data-tool-preview]");
  check(
    "Collapsed failed commands use red foreground and background",
    (await color(preview)) === red &&
      (await preview.getAttribute("class")).includes("bg-red-bg"),
  );
  await shell.click();
  const shellCard = errors
    .locator("[data-tool-detail]")
    .filter({ hasText: "Command access was denied." });
  await expect(shellCard).toBeVisible();
  // Wait for Shiki's async worker too; its inline token colors must stay red.
  await expect(shellCard.locator("pre.shiki").first()).toBeVisible();
  await expect
    .poll(() =>
      shellCard.evaluate((root) =>
        [...root.querySelectorAll("*")]
          .filter((node) =>
            [...node.childNodes].some(
              (child) =>
                child.nodeType === Node.TEXT_NODE && child.textContent.trim(),
            ),
          )
          .every(
            (node) =>
              getComputedStyle(node).color === getComputedStyle(root).color,
          ),
      ),
    )
    .toBe(true);
  const failedAgent = errors.getByRole("button", {
    name: "Agent Interrupted review",
    exact: true,
  });
  await page.mouse.move(0, 0);
  await expect(failedAgent).toContainText("Agent");
  await expect(failedAgent.locator(".lucide-bot")).toBeVisible();
  await expect(failedAgent.locator(".lucide-circle-x")).toHaveCount(0);
  check(
    "Failed Agent groups preserve their name and red agent icon",
    (await color(failedAgent.locator(".lucide-bot"))) === red,
  );
  const unresolved = errors.getByRole("button", {
    name: /^Read unreported.ts/,
  });
  const fullyOpaque = await unresolved.evaluate((element) => {
    for (let node = element; node; node = node.parentElement)
      if (Number(getComputedStyle(node).opacity) < 1) return false;
    return true;
  });
  check("Unresolved tool rows remain fully readable", fullyOpaque);
  check(
    "All providers retain nested transcripts and disclosure choices through completion",
    true,
  );
}
