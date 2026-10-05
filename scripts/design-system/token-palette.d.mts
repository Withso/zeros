// Types for token-palette.mjs (consumed by the renderer's contrast-contract test).

export type Rgb = [number, number, number];
export type ThemeMap = Map<string, string>;
export interface Themes {
  dark: ThemeMap;
  light: ThemeMap;
}

export interface ContrastContract {
  description?: string;
  surfaces: Record<string, string[]>;
  roles: Record<string, { min: number; why?: string }>;
  pairs: Array<{ role: string; fg: string[]; on: string | string[]; why?: string }>;
  ladders?: Array<{ tiers: string[]; on: string; minStep: number; why?: string }>;
  exempt: Array<{ tokens: string[]; why: string }>;
}

export interface PairResult {
  theme: string;
  role: string;
  fg: string;
  surface: string;
  ratio: number;
  min: number;
  pass: boolean;
}

export interface LadderResult {
  theme: string;
  upper: string;
  lower: string;
  on: string;
  step: number;
  minStep: number;
  pass: boolean;
}

export const TOKENS_FILE: string;
export function extractBlockRange(css: string, selector: string): [number, number];
export function extractBlock(css: string, selector: string): string;
export function declarations(block: string): ThemeMap;
export function readThemes(root?: string, css?: string): Themes;
export function hslToRgb(h: number, s: number, l: number): Rgb;
export function resolveValue(theme: ThemeMap, name: string): string;
export function resolveRgb(theme: ThemeMap, name: string): Rgb;
export function resolveSurface(theme: ThemeMap, ref: string): Rgb;
export function relativeLuminance(rgb: Rgb): number;
export function contrastRatio(a: Rgb, b: Rgb): number;
export function toHex(rgb: Rgb): string;
export function expandSurfaces(contract: ContrastContract, on: string | string[]): string[];
export function evaluateContract(contract: ContrastContract, themes: Themes): PairResult[];
export function evaluateLadders(contract: ContrastContract, themes: Themes): LadderResult[];
