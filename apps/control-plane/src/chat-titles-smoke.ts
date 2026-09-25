// Opt-in live API check: synthetic prompts only, at most three paid requests.
import { existsSync } from "node:fs";
import { generateChatTitle } from "./chat-titles.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.CHAT_TITLE_OPENAI_API_KEY?.trim();
if (!key) {
  console.error(
    "Set CHAT_TITLE_OPENAI_API_KEY in apps/control-plane/.env or the process environment.",
  );
  process.exitCode = 1;
} else {
  for (const prompt of [
    "Fix the login redirect bug after signing out",
    "Add a keyboard shortcut to open settings",
    "Explain how database transactions prevent partial writes",
  ]) {
    const title = await generateChatTitle(key, prompt);
    if (!title) {
      console.error(
        "No valid title returned. Check the key, model access, billing, and network; no retry was made.",
      );
      process.exitCode = 1;
      break;
    }
    console.log(title);
  }
}
