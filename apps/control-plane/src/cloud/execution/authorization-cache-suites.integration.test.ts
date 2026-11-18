// Reruns the suites whose checks go through cached token verdicts with the cache on (authorization-cache.ts); their own
// files run them with it off. Database-backed: the suites skip without TEST_DATABASE_URL.
process.env.TEST_EXECUTION_AUTH_CACHE ??= "on";
await import("./proxy.integration.test.js");
await import("./sender-continuation.integration.test.js");
await import("./payer-lifetime.integration.test.js");
