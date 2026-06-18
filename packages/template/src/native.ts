import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface NativeDirectoryEntry {
  readonly path: string;
  readonly type: "directory";
}

export interface NativeFileEntry {
  readonly path: string;
  readonly type: "file";
  readonly content: Uint8Array;
  readonly mode: number;
}

export type NativeRenderEntry = NativeDirectoryEntry | NativeFileEntry;

export interface NativeRenderOptions {
  readonly afterDestinationOpen?: () => void;
  readonly afterTemporaryFileCreated?: () => void;
  readonly failDuringWritePath?: string;
  readonly failBeforePublishPath?: string;
  readonly failIdentityInspectionPath?: string;
}

export interface NativeRenderResult {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
}

interface NativeBinding {
  renderEntries(
    destination: string | number,
    entries: readonly NativeRenderEntry[],
    options?: NativeRenderOptions,
  ): NativeRenderResult;
}

const binding = require(
  "../build/Release/scaflow_template_native.node",
) as NativeBinding;

export function renderEntriesNative(
  destination: string | number,
  entries: readonly NativeRenderEntry[],
  options?: NativeRenderOptions,
): NativeRenderResult {
  return binding.renderEntries(destination, entries, options);
}
