#!/usr/bin/env node

import { deploymentEnvironmentErrors } from "../lib/deployment-env.mjs";

const errors = deploymentEnvironmentErrors(process.env);
if (errors.length > 0) {
  console.error("Cloudflare deployment environment is unsafe:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
if (process.env.CF_PAGES === "1") {
  console.log(
    `Cloudflare deployment environment verified: ${process.env.ZEROS_DEPLOY_ENV}`,
  );
}
