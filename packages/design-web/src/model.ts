import type {
  DesignFoundationManifest,
  DesignOperation,
  DesignParameterValue,
} from "@zeros/design-core";

export const DESIGN_WEB_SCHEMA_VERSION = 1 as const;
export const DESIGN_WEB_MAX_FILES = 1_024;
export const DESIGN_WEB_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DESIGN_WEB_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export interface DesignSourceSpan {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface DesignWebNode {
  id: string;
  tag: string;
  file: string;
  parentId: string | null;
  childIds: string[];
  attributes: Readonly<Record<string, string>>;
  directText: string;
  span: DesignSourceSpan;
  startTag: DesignSourceSpan;
  endTag: DesignSourceSpan | null;
}

export interface DesignWebDiagnostic {
  severity: "error" | "warning";
  code:
    | "html-parse"
    | "identity-missing"
    | "identity-duplicate"
    | "css-parse"
    | "source-limit";
  message: string;
  file: string;
  nodeId?: string;
  span?: DesignSourceSpan;
}

export interface DesignWebProjection {
  documentId: string;
  revision: string;
  entryFile: string;
  nodes: DesignWebNode[];
  rootIds: string[];
  diagnostics: DesignWebDiagnostic[];
}

export interface DesignFrameGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

export interface DesignWebDocumentState {
  schemaVersion: typeof DESIGN_WEB_SCHEMA_VERSION;
  documentId: string;
  revision: string;
  entryFile: string;
  files: Readonly<Record<string, string>>;
  manifest: DesignFoundationManifest;
  frames: Readonly<Record<string, DesignFrameGeometry>>;
}

export interface DesignWebDocumentInput {
  documentId: string;
  entryFile: string;
  files: Readonly<Record<string, string>>;
  manifest?: unknown;
  frames?: Readonly<Record<string, DesignFrameGeometry>>;
}

export interface DesignSourceSplice {
  file: string;
  start: number;
  deleteText: string;
  insertText: string;
}

export interface DesignWebMutation {
  state: DesignWebDocumentState;
  changed: boolean;
  inverseOperations: DesignOperation[];
  affectedNodeIds: string[];
  affectedFiles: string[];
  decisions?: DesignStyleMutationDecision[];
}

export type DesignStyleOrigin =
  | "inline"
  | "stylesheet"
  | "token"
  | "component"
  | "computed"
  | "inherited"
  | "preview"
  | "ambiguous";

export interface DesignAuthoredDeclaration {
  origin: "inline" | "stylesheet" | "token" | "component";
  property: string;
  value: string;
  important: boolean;
  file: string;
  selector: string | null;
  conditions: string[];
  span: DesignSourceSpan;
  writable: boolean;
}

export interface DesignRuntimeMatchedDeclaration {
  property: string;
  value: string;
  important?: boolean;
  selector?: string;
  sourceFile?: string;
  sourceLine?: number;
  inherited?: boolean;
  active?: boolean;
}

export interface DesignStyleProvenance {
  nodeId: string;
  property: string;
  computedValue: string | null;
  winner: DesignAuthoredDeclaration | null;
  candidates: DesignAuthoredDeclaration[];
  origin: DesignStyleOrigin;
  confidence: "exact" | "correlated" | "ambiguous" | "computed-only";
  reason: string;
}

export interface DesignStyleMutationDecision {
  property: string;
  requestedScope: "auto" | "inline" | "rule" | "component" | "instance";
  appliedScope: "inline" | "rule";
  file: string;
  selector: string | null;
  reason:
    | "existing-inline"
    | "explicit-inline"
    | "single-authored-rule"
    | "inline-fallback-no-rule"
    | "inline-fallback-ambiguous-rule";
}

export interface DesignParameterResolution {
  parameterId: string;
  value: DesignParameterValue;
  variantId: string | null;
}
