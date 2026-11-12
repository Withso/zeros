import { GitMirror, runGit, type GitSource, type GitState } from "./git";
import { assertGitCurrent } from "./git-storage";
import { SharedGitMirror, type SharedGitOptions, type SharedGitScope } from "./shared-git";
import type { WorkspaceSyncStorage } from "../../shared/workspace-sync";

export class CloudGitMirror extends GitMirror {
  private shared?: SharedGitMirror;
  constructor(root: string, meta: string, private readonly options: Omit<SharedGitOptions, "scope"> & { scope(): Promise<SharedGitScope> }) {
    super(root, meta, async (args, command) => {
      assertGitCurrent(options);
      const result = await (options.git ?? runGit)(args, { ...command, signal: options.signal });
      assertGitCurrent(options);
      return result;
    }, options.now);
  }

  private async resolveShared(): Promise<SharedGitMirror | undefined> {
    assertGitCurrent(this.options);
    if (this.shared) return this.shared;
    try {
      const scope = await this.options.scope();
      assertGitCurrent(this.options);
      this.shared = new SharedGitMirror(this.root, this.meta, { ...this.options, scope, git: this.git });
    } catch { assertGitCurrent(this.options); }
    return this.shared;
  }

  override async current(previous: GitState): Promise<boolean> {
    const shared = await this.resolveShared();
    return shared ? shared.current(previous) : super.current(previous);
  }
  override async apply(source: GitSource, previous: GitState | undefined): Promise<GitState | "too_many_bytes"> {
    const shared = await this.resolveShared();
    if (shared) return shared.apply(source, previous);
    const fenced: GitSource = {
      bootstrap: async have => { assertGitCurrent(this.options); const reply = await source.bootstrap(have); assertGitCurrent(this.options); return reply; },
      bundleRead: async (...args) => { assertGitCurrent(this.options); const reply = await source.bundleRead(...args); assertGitCurrent(this.options); return reply; },
    };
    return super.apply(fenced, previous);
  }
  override async storage(changed = false): Promise<WorkspaceSyncStorage | undefined> { return this.shared?.storage(changed); }
}
