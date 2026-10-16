import { editAlphaRelease } from "./alpha-release-edit";
import { PromotionError } from "./contracts";

const controller = new AbortController();
const cancel = () => controller.abort();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
void editAlphaRelease({
  repository: process.env.GITHUB_REPOSITORY ?? "",
  sha: process.env.GITHUB_SHA ?? "",
  title: process.env.ALPHA_RELEASE_TITLE ?? "",
  notes: process.env.ALPHA_RELEASE_NOTES ?? "",
}, controller.signal).catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Alpha release metadata edit failed; publication stopped.");
  process.exitCode = 1;
}).finally(() => {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
});
