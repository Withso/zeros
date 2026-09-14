import { expect } from "@playwright/test";

export async function runCodexTranscriptSmoke({ page, check }) {
  await page.goto(
    `${new URL(page.url()).origin}/apps/desktop/src/renderer/harnesses/harness-codex-transcript.html`,
  );
  const transcript = page.locator("#codex-transcript");
  await expect(
    transcript.getByText("I am checking the implementation."),
  ).toBeVisible();
  await expect(
    transcript.getByRole("button", { name: /Bash pnpm test/ }),
  ).toBeVisible();
  await transcript.getByRole("button", { name: /Thinking/ }).click();
  await expect(
    transcript
      .getByText("Reviewing the event boundaries.", { exact: true })
      .last(),
  ).toBeVisible();
  await transcript.getByRole("button", { name: /Bash pnpm typecheck/ }).click();
  await expect(transcript.getByText("Exit code: 0")).toBeVisible();
  await expect(transcript.getByText("No output was captured.")).toBeVisible();
  await expect(transcript.getByText(/\/workspace/).first()).toBeVisible();
  await transcript.getByRole("button", { name: /Find in page/ }).click();
  await expect(transcript.getByText(/API reference found/)).toBeVisible();
  const a = transcript.getByRole("button", { name: /^Edit a.ts/ });
  const b = transcript.getByRole("button", { name: /^Edit b.ts/ });
  await a.click();
  await expect(a).toHaveAttribute("aria-expanded", "true");
  await expect(b).toHaveAttribute("aria-expanded", "false");
  await b.click();
  await expect(b).toHaveAttribute("aria-expanded", "true");
  await expect(
    transcript.getByText("/workspace/a.ts", { exact: true }),
  ).toBeVisible();
  await expect(
    transcript.getByText("/workspace/b.ts", { exact: true }),
  ).toBeVisible();
  await transcript.getByRole("button", { name: /^Future tool/ }).click();
  await expect(transcript.getByText(/Captured future result/)).toBeVisible();
  await transcript.getByRole("button", { name: /Bash pnpm verify/ }).click();
  await expect(transcript.getByText("Exit code: 1")).toBeVisible();
  await expect(
    transcript.getByText("Verification failed", { exact: true }),
  ).toBeVisible();
  await transcript
    .getByRole("button", { name: "Agent Worker result", exact: true })
    .click();
  await expect(
    transcript.getByText(/Worker completed its audit/),
  ).toBeVisible();
  check(
    "Live commentary, reasoning, running tools and every expanded tool fixture expose their details",
    true,
  );

  await page
    .getByRole("button", { name: "Complete turn", exact: true })
    .click();
  await expect(
    transcript.getByText("The final answer stays visible."),
  ).toBeVisible();
  await transcript.getByRole("button", { name: /tool calls/ }).click();
  await expect(
    transcript.getByRole("button", {
      name: /^Background agent completed/,
    }),
  ).toBeVisible();
  await expect(
    transcript.getByText("The final answer stays visible."),
  ).toBeVisible();
  check("Late background tools cannot hide a completed final answer", true);

  const composer = page.getByRole("textbox", { name: "Composer", exact: true });
  await composer.fill("1");
  await composer.press("Enter");
  await composer.press("Escape");
  await expect(page.locator("#question-response")).toHaveText("null");
  await expect(composer).toHaveValue("1\n");
  await page
    .getByRole("button", { name: "Toggle active", exact: true })
    .click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Enter");
  await expect(page.locator("#question-response")).toHaveText("null");
  await page
    .getByRole("button", { name: "Toggle active", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Submit answer", exact: true })
    .click();
  await expect(page.locator("#question-response")).toContainText(
    '"selectedOptionIds":["json"]',
  );
  check(
    "Optional questions keep the composer usable and cannot submit from inactive or unrelated keyboard input",
    true,
  );
}
