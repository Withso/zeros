// Repository automation only. Never import engine services or customer credentials.
export const SCHEMA = 1;
export const REPOSITORY = "Withso/zeros";
export const HOLD_LABEL = "agent-runtime:hold";
export const REGENERATE_LABEL = "agent-runtime:regenerate";
export const BRANCH_PREFIX = "automation/agent-runtime/";
export const LABELS = ["dependencies", "automated", "agent-pin"];
export const DAY = 86_400_000;
export const LIMITS = Object.freeze({
  state: 48 * 1024,
  comment: 60 * 1024,
  source: 16 * 1024 * 1024,
  registry: 32 * 1024 * 1024,
  report: 2 * 1024 * 1024,
  patch: 24 * 1024 * 1024,
  file: 8 * 1024 * 1024,
  files: 4000,
  pages: 20,
  timeout: 25_000,
});

export const PROVIDERS = Object.freeze({
  claude: {
    name: "Claude",
    package: "@anthropic-ai/claude-agent-sdk",
    releaseRepo: "anthropics/claude-agent-sdk-typescript",
    notes: "https://github.com/anthropics/claude-agent-sdk-typescript/releases",
    declarations: ["sdk.d.ts"],
  },
  codex: {
    name: "Codex",
    package: "@openai/codex",
    releaseRepo: "openai/codex",
    notes: "https://github.com/openai/codex/releases",
    declarations: [],
  },
  cursor: {
    name: "Cursor",
    package: "@cursor/sdk",
    notes: "https://cursor.com/docs/release-notes/sdk",
    declarations: [], // Resolve the declaration entry point from the exact package.
  },
});

export const PUBLIC_NOTES = Object.freeze([
  {
    id: "claude-code-notes",
    provider: "claude",
    url: "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md",
    advisory: true,
  },
  {
    id: "codex-notes",
    provider: "codex",
    url: "https://developers.openai.com/codex/changelog/",
    advisory: true,
  },
  {
    id: "cursor-sdk-notes",
    provider: "cursor",
    url: "https://cursor.com/docs/release-notes/sdk",
    advisory: false,
  },
  {
    id: "cursor-cli-notes",
    provider: "cursor",
    url: "https://cursor.com/docs/cli/changelog",
    advisory: true,
  },
]);

export const WATCHES = Object.freeze([
  {
    id: "cursor-computer-use",
    provider: "cursor",
    terms: ["computer use", "computer_use", "computerUse"],
    requirement:
      "SDK local agents on macOS and Zeros Linux VMs; a type or announcement alone is not qualification.",
  },
  {
    id: "cursor-approvals",
    provider: "cursor",
    terms: ["approval", "permission callback"],
    requirement: "Host-interactive approval callbacks for built-in tools.",
  },
  {
    id: "cursor-shell-output",
    provider: "cursor",
    terms: ["shell output", "stdout", "streaming output"],
    requirement: "Live shell bytes before tool completion.",
  },
  {
    id: "provider-auth",
    provider: "all",
    terms: ["authentication", "credential", "oauth", "permission", "config"],
    requirement:
      "Review native auth/cache/config compatibility, including the independent Codex keeper.",
  },
  {
    id: "provider-models",
    provider: "all",
    terms: ["model", "context window", "reasoning effort", "fast mode"],
    requirement:
      "Confirm documented client minimums and account-qualified model/capability availability.",
  },
]);

export function providerConfig(provider) {
  if (!Object.hasOwn(PROVIDERS, provider))
    throw new Error("Unknown runtime provider.");
  return PROVIDERS[provider];
}

export function managedPath(provider, file) {
  providerConfig(provider);
  if (
    ["package.json", "pnpm-lock.yaml", "THIRD-PARTY-LICENSES.txt"].includes(
      file,
    )
  )
    return true;
  return (
    provider === "codex" &&
    /^apps\/desktop\/src\/engine\/agents\/adapters\/codex\/generated\/(?:[A-Za-z0-9_-]+\/)*(?:[A-Za-z0-9_.-]+\.(?:ts|json)|LICENSE|NOTICE|\.version)$/.test(
      file,
    ) &&
    !file.split("/").some((part) => part === ".." || part === ".")
  );
}
