"use client";

import type { LibraryEntry } from "@/lib/fs/types";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import {
  EditPanel,
  NewerDevelopReadOnlyPanel,
  PreparingDevelopPanel,
} from "@/components/develop/EditPanel";
import {
  DevelopPanelRail,
  type DevelopPanelId,
} from "@/components/develop/DevelopPanelRail";
import { MetadataPanel } from "@/components/viewer/MetadataPanel";
import { useDevelopStore } from "@/stores/develop-store";
import type { CpuAnalysisTapResult } from "@/lib/develop/v3/cpu-backend";
import type {
  V3CanvasDiagnostic,
  V3CanvasTool,
} from "@/components/develop/DevelopCanvas";
import { DevelopJobDrawer } from "@/components/develop/DevelopJobDrawer";
import { DevelopHistoryPanel } from "@/components/develop/DevelopHistoryPanel";
import { DevelopDefaultsPanel } from "@/components/develop/DevelopDefaultsPanel";
import type { DevelopDefaultFacts } from "@/lib/develop/defaults/matcher";
import type { DevelopDefaultsResolution } from "@/components/develop/useDevelopSettingsSync";
import { StatusCard } from "@/components/develop/V3PanelControls";

interface DevelopSidePanelsProps {
  decoded: DevelopImage;
  entry: LibraryEntry;
  activePanel: DevelopPanelId | null;
  onSelect: (panel: DevelopPanelId) => void;
  resultId: string;
  resultCatalogRevision: number;
  resultEntryIds: readonly string[];
  missingEntryIds: readonly string[];
  resultEntries: readonly LibraryEntry[];
  v3Analysis: readonly CpuAnalysisTapResult[];
  v3RenderDiagnostics: readonly V3CanvasDiagnostic[];
  v3CanvasTool: V3CanvasTool;
  onV3CanvasToolChange: (tool: V3CanvasTool) => void;
  defaultFacts: DevelopDefaultFacts | null | undefined;
  defaultsResolution: DevelopDefaultsResolution;
}

export function DevelopSidePanels({
  decoded,
  entry,
  activePanel,
  onSelect,
  resultId,
  resultCatalogRevision,
  resultEntryIds,
  missingEntryIds,
  resultEntries,
  v3Analysis,
  v3RenderDiagnostics,
  v3CanvasTool,
  onV3CanvasToolChange,
  defaultFacts,
  defaultsResolution,
}: DevelopSidePanelsProps) {
  const processKind = useDevelopStore((state) => state.activeEntryId ? state.sessions[state.activeEntryId]?.processKind : undefined);
  const projectionConflict = useDevelopStore((state) => state.activeEntryId
    ? state.sessions[state.activeEntryId]?.ui.projection.kind === "divergent" : false);
  const readOnly = useDevelopStore((state) => state.activeEntryId ? state.sessions[state.activeEntryId]?.readOnly : undefined);
  const sidecarError = useDevelopStore((state) => state.activeEntryId ? state.sessions[state.activeEntryId]?.ui.sidecarError : undefined);
  const effectivePanel = projectionConflict ? "history" : activePanel;
  const defaultsPending = defaultsResolution.kind === "pending";
  const panel = effectivePanel === "history" ? (
    <DevelopHistoryPanel key={`${entry.catalogId}:${entry.id}`} entry={entry} editingDisabled={defaultsPending} />
  ) : effectivePanel === "defaults" && defaultFacts ? (
    <DevelopDefaultsPanel key={`${entry.catalogId}:${entry.id}`} entry={entry} facts={defaultFacts} editingDisabled={defaultsPending} />
  ) : effectivePanel === "defaults" ? (
    <aside className="w-[352px] shrink-0 border-l border-lr-border-subtle bg-lr-panel p-4"><StatusCard title="Source facts unavailable">Defaults need verified decoder, camera-profile, and source facts.</StatusCard></aside>
  ) : effectivePanel === "info" ? (
    <MetadataPanel
      entry={entry}
      decodedMetadata={decoded.metadata}
    />
  ) : processKind === "v3" && defaultsResolution.kind !== "pending" ? (
    <EditPanel
      key={effectivePanel ?? "edit"}
      decoded={decoded}
      entry={entry}
      activePanel={effectivePanel}
      analysis={v3Analysis}
      diagnostics={v3RenderDiagnostics}
      canvasTool={v3CanvasTool}
      onCanvasToolChange={onV3CanvasToolChange}
      batch={{
        sourceEntry: entry,
        entries: resultEntries,
        resultId,
        catalogRevision: resultCatalogRevision,
        resultEntryIds,
        missingEntryIds,
      }}
    />
  ) : processKind === "read-only-newer" && readOnly ? (
    <NewerDevelopReadOnlyPanel
      version={readOnly.foundVersion}
      reason={readOnly.message}
    />
  ) : (
    <PreparingDevelopPanel error={sidecarError ?? null} />
  );

  return (
    <>
      {panel}
      <DevelopPanelRail
        activePanel={effectivePanel}
        onSelect={onSelect}
    editingDisabled={processKind !== "v3" || projectionConflict || defaultsPending}
      />
      <DevelopJobDrawer />
    </>
  );
}
