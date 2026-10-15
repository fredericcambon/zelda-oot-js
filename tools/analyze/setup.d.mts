export const GHIDRA_VERSION: string;
export const toolsDir: string;
export const ghidraDir: string;
export const jdkDir: string;
export function javaHome(): string;
export function analyzeHeadlessPath(): string;
export function setup(): Promise<void>;
