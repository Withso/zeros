// Standalone development harness — NOT part of the shipped app.
//
// It renders the real GitHub settings section against a metadata-only native
// bridge double so the Radix overflow/dialog focus contract can be exercised
// in Chromium by scripts/ui-smoke-composer.mjs.
import "../styles/zeros-tokens.css";
import "../styles/semantic-tokens.css";
import "../styles/globals.css";

import type { GithubAuthSnapshot } from "@zeros/core/github-auth";

const snapshot: GithubAuthSnapshot = {
  selectedMethod: "github-app",
  methods: {
    "gh-cli": {
      method: "gh-cli",
      health: "connected",
      configured: true,
      available: true,
      login: "octocat",
    },
    "github-app": {
      method: "github-app",
      health: "connected",
      configured: true,
      login: "octocat",
      installationCount: 1,
      activeInstallationCount: 1,
      repositoryCount: 3,
      allRepositories: false,
    },
    pat: {
      method: "pat",
      health: "not-connected",
      configured: false,
    },
  },
};

window.__ZEROS_NATIVE__ = {
  async invoke<T>(command: string): Promise<T> {
    if (command === "gh_auth_snapshot") {
      // Leave a genuine cold-read window so the browser smoke can prove that
      // placeholder state does not flash false sign-in controls.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return snapshot as T;
    }
    // The read-only commands a smoke click can reach resolve quietly. The smoke
    // asserts "no uncaught page errors", so a rejection here would fail the run
    // for exercising the UI rather than for a defect in it.
    if (command === "gh_app_cancel" || command === "shell_open_url") {
      return null as T;
    }
    throw new Error(`GitHub settings harness received ${command}`);
  },
  on() {
    return () => {};
  },
};

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("./zeros/ui/primitives/tooltip");
  const { GitHubSection } = await import("./zeros/panels/github-section");

  function Harness() {
    return (
      <TooltipProvider delayDuration={500} skipDelayDuration={0}>
        <main className="bg-bg1 min-h-screen p-10">
          <div className="mx-auto max-w-2xl">
            <GitHubSection />
          </div>
        </main>
      </TooltipProvider>
    );
  }

  createRoot(document.getElementById("root")!).render(<Harness />);
}

void main();
