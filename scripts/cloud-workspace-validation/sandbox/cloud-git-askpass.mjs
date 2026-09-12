#!/usr/bin/env node

const prompt = process.argv[2] ?? "";
const host = process.env.ZEROS_GIT_ASKPASS_HOST ?? "";
const username = process.env.ZEROS_GIT_ASKPASS_USERNAME ?? "";
const password = process.env.ZEROS_GIT_ASKPASS_PASSWORD ?? "";

delete process.env.ZEROS_GIT_ASKPASS_HOST;
delete process.env.ZEROS_GIT_ASKPASS_USERNAME;
delete process.env.ZEROS_GIT_ASKPASS_PASSWORD;

const promptMatch = /^(Username|Password) for '([^']+)': ?$/i.exec(prompt);
let promptUrl = null;
try {
  promptUrl = promptMatch ? new URL(promptMatch[2]) : null;
} catch {
  promptUrl = null;
}

if (
  host !== "github.com" ||
  promptUrl?.protocol !== "https:" ||
  promptUrl.hostname.toLowerCase() !== host ||
  (promptUrl.port !== "" && promptUrl.port !== "443") ||
  username !== "x-access-token" ||
  password.length < 1 ||
  password.length > 4_096 ||
  /[\0\r\n]/.test(password)
) {
  process.exitCode = 1;
} else if (promptMatch?.[1].toLowerCase() === "username") {
  process.stdout.write(`${username}\n`);
} else if (promptMatch?.[1].toLowerCase() === "password") {
  process.stdout.write(`${password}\n`);
} else {
  process.exitCode = 1;
}
