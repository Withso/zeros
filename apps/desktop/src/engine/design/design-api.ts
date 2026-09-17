import path from "node:path";

import {
  DesignApi,
  type DesignDocumentRepository,
  type DesignWebDocumentInput,
  type DesignWebDocumentState,
} from "@zeros/design-web";

import {
  commitDesignWebDocumentState,
  designWebDocumentId,
  readDesignWebDocumentState,
} from "./document";
import { withDesignDirectoryNameLease } from "./directory-registry";

const MAX_WORKSPACE_DESIGN_APIS = 8;
const workspaceApis = new Map<string, DesignApi>();

function frameFromDocumentId(documentId: string): string {
  if (!documentId.startsWith("frame:")) {
    throw new Error(`Invalid web design document id: ${documentId}`);
  }
  const frame = documentId.slice("frame:".length);
  // document.ts owns the portable frame validator.
  if (designWebDocumentId(frame) !== documentId) {
    throw new Error(`Invalid web design document id: ${documentId}`);
  }
  return frame;
}

/** Engine-owned semantic repository backed by the workspace checkout. Drafts
 * are ordinary uncommitted Design files, written through the transaction
 * journal/CAS implementation in document.ts.
 * Agent adapters receive a DesignApi backed by this store; they never receive
 * this path or direct filesystem authority. */
export class DesignDraftStore implements DesignDocumentRepository {
  constructor(
    private readonly workspacePath: string,
    private readonly options: {
      directory?: string;
      assertAuthorized?: () => void;
    } = {},
  ) {}

  private async withAuthority<T>(
    run: (root: string) => Promise<T>,
  ): Promise<T> {
    this.options.assertAuthorized?.();
    const invoke = (root: string) => this.options.directory
      ? withDesignDirectoryNameLease(root, this.options.directory, () => run(root))
      : run(root);
    const result = await invoke(this.workspacePath);
    this.options.assertAuthorized?.();
    return result;
  }

  async read(documentId: string): Promise<DesignWebDocumentInput> {
    const state = await this.withAuthority((root) =>
      readDesignWebDocumentState(root, frameFromDocumentId(documentId)),
    );
    return {
      documentId: state.documentId,
      entryFile: state.entryFile,
      files: state.files,
      manifest: state.manifest,
      frames: state.frames,
    };
  }

  async commit(input: {
    documentId: string;
    expectedRevision: string;
    state: DesignWebDocumentState;
  }): Promise<void> {
    await this.withAuthority((root) =>
      commitDesignWebDocumentState(
        root,
        frameFromDocumentId(input.documentId),
        input.expectedRevision,
        input.state,
        { assertAuthorized: this.options.assertAuthorized },
      ),
    );
  }
}

export function getWorkspaceDesignApi(workspacePath: string): DesignApi {
  const key = path.resolve(workspacePath);
  const retained = workspaceApis.get(key);
  if (retained) {
    workspaceApis.delete(key);
    workspaceApis.set(key, retained);
    return retained;
  }
  const api = new DesignApi(new DesignDraftStore(key), {
    // This instance is retained exclusively behind WorkspaceService's local,
    // workspace-id-resolved human Design surface. Any future agent/transport
    // adapter must construct its own fail-closed, capability-authorized API.
    authorization: { kind: "trusted-in-process" },
    maxSessions: 16,
    maxSessionBytes: 32 * 1024 * 1024,
  });
  workspaceApis.set(key, api);
  while (workspaceApis.size > MAX_WORKSPACE_DESIGN_APIS) {
    const oldest = workspaceApis.keys().next().value as string | undefined;
    if (!oldest) break;
    workspaceApis.delete(oldest);
  }
  return api;
}

export function designDocumentIdForFrame(frame: string): string {
  return designWebDocumentId(frame);
}

export function forgetWorkspaceDesignApi(workspacePath: string): void {
  workspaceApis.delete(path.resolve(workspacePath));
}

export function resetWorkspaceDesignApisForTests(): void {
  workspaceApis.clear();
}
