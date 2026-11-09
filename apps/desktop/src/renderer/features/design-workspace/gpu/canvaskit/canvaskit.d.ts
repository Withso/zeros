// Types of the vendored build: canvaskit-wasm 0.42.0's API plus the bindings
// zeros-design.patch adds (shared typefaces and the externalized-font registry).
import type { CanvasKit, CanvasKitInitOptions } from "canvaskit-wasm";

export interface DesignCanvasKit extends CanvasKit {
  readonly HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  /** Takes ownership of `bytes` at `pointer`, allocated with `_malloc`. */
  _RegisterDesignTypeface(id: string, pointer: number, bytes: number): boolean;
  HasDesignTypeface(id: string): boolean;
  UnregisterDesignTypeface(id: string): void;
  DesignTypefaceRegistryCount(): number;
  DesignTypefaceRegistryBytes(): number;
  TypefaceCacheCount(): number;
  TypefaceCacheBytes(): number;
  TypefaceCacheHits(): number;
  TypefaceCacheMisses(): number;
  ClearTypefaceCache(): void;
}

export default function CanvasKitInit(options?: CanvasKitInitOptions): Promise<DesignCanvasKit>;
