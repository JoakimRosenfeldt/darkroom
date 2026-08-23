import {
  DEFAULT_NIKON_RUNTIME,
  FORMAT_CAPABILITIES,
  OPERATION_CAPABILITIES,
} from "./registry.ts";
import type {
  CameraSupportRow,
  FormatCapabilityReport,
  NikonRuntimeCapability,
} from "./types.ts";

export { DEFAULT_NIKON_RUNTIME } from "./registry.ts";

function qualifiedCameraRows(rows: readonly CameraSupportRow[] | undefined): readonly CameraSupportRow[] {
  return (rows ?? []).filter((row) => /^[0-9a-f]{64}$/.test(row.sampleChecksum ?? ""));
}

export function createFormatCapabilityReport(input: {
  appVersion: string;
  platform: string;
  architecture: string;
  nikon?: NikonRuntimeCapability;
  cameraRows?: readonly CameraSupportRow[];
}): FormatCapabilityReport {
  return {
    version: 1,
    appVersion: input.appVersion,
    platform: input.platform,
    architecture: input.architecture,
    formats: FORMAT_CAPABILITIES,
    operations: OPERATION_CAPABILITIES,
    cameraRows: qualifiedCameraRows(input.cameraRows),
    nikon: input.nikon ?? DEFAULT_NIKON_RUNTIME,
  };
}

export function serializeFormatCapabilityReport(
  report: FormatCapabilityReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
