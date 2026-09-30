export function workerEnvironment(): NodeJS.ProcessEnv {
  return { CI: "true", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_SHA: "a".repeat(40), GITHUB_REPOSITORY: "example/zeros",
    GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", RELEASE_CHANNEL: "alpha", RELEASE_SHA: "a".repeat(40), RELEASE_BRANCH: "main",
    ZEROS_WORKER_PROMOTION: "enabled", BOAT_API_KEY: "synthetic-boat-authority", BOAT_BILLING_ORG: "test-wallet", BOAT_ACCOUNT_SCOPE: "test-account",
    BOAT_BASE_SNAPSHOT: "test-base", RAILWAY_DEPLOY_TOKEN: "synthetic-railway-authority", PLANETSCALE_SERVICE_TOKEN_ID: "synthetic-token-id",
    PLANETSCALE_SERVICE_TOKEN: "synthetic-planetscale-authority", GH_TOKEN: "synthetic-github-authority", WORKER_ADMISSION_CONFIG_JSON: "{}",
    RAILWAY_PROJECT_ID: "11111111-1111-4111-8111-111111111111", RAILWAY_ENVIRONMENT_ID: "22222222-2222-4222-8222-222222222222",
    RAILWAY_SERVICE_ID: "33333333-3333-4333-8333-333333333333", RUNTIME_QUALIFICATION_ACTOR_USER_ID: "44444444-4444-4444-8444-444444444444",
    WORKER_CANARY_ORGANIZATION_ID: "55555555-5555-4555-8555-555555555555", WORKER_CANARY_ADMISSION_TOKEN: "synthetic-protected-canary-admission-token",
    PLANETSCALE_ORG: "test-org", PLANETSCALE_DATABASE: "zeros-control-plane-alpha", PLANETSCALE_BRANCH: "main",
    RUNTIME_QUALIFICATION_CREDENTIAL_KINDS: "claude-setup-token,codex-chatgpt,cursor-api-key", BOAT_BUILDER_BUDGET_HOURS: "1",
    BOAT_CANARY_BUDGET_HOURS: "0.25", BOAT_WORKER_BUDGET_HOURS: "2" };
}
export function workerConnections() {
  return [
    { kind: "claude-setup-token" as const, credentialId: "11111111-1111-4111-8111-111111111111", model: "claude-haiku-4-5" },
    { kind: "codex-chatgpt" as const, credentialId: "22222222-2222-4222-8222-222222222222", model: "gpt-5.6-luna" },
    { kind: "cursor-api-key" as const, credentialId: "33333333-3333-4333-8333-333333333333", model: "composer-2.5" },
  ].map((row, index) => ({ ...row, credentialRevision: 1, designationId: String(40 + index) }));
}
