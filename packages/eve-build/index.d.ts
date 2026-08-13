export { build, copyPublicAssets, createNitro, prepare, prerender } from "nitro/builder";
export type { H3Event } from "nitro";
export type { Nitro } from "nitro/types";

export declare const EVE_BUILD_ENGINE_PROTOCOL: 1;

export interface RolldownOutputChunk {
  readonly type: "chunk";
  readonly code: string;
  readonly fileName: string;
}

export interface RolldownOutputAsset {
  readonly type: "asset";
  readonly fileName: string;
  readonly source: string | Uint8Array;
}

export interface RolldownOutput {
  readonly output: readonly [RolldownOutputChunk, ...(RolldownOutputChunk | RolldownOutputAsset)[]];
}

export declare function buildWithRolldown(
  options: Record<string, unknown>,
): Promise<RolldownOutput>;

export declare function parseWithRolldown(
  sourceText: string,
  options?: Record<string, unknown> | null,
  filename?: string,
): Promise<unknown>;

export declare function resolveNitroDependency(specifier: string): string;
