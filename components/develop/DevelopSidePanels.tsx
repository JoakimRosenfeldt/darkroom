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
}: DevelopSidePanelsProps) {
  const session = useDevelopStore((state) => {
    const entryId = state.activeEntryId;
    return entryId ? state.sessions[entryId] : undefined;
  });

  const panel = activePanel === "info" ? (
    <MetadataPanel
      entry={entry}
      decodedMetadata={decoded.metadata}
    />
  ) : session?.processKind === "v3" ? (
    <EditPanel
      key={activePanel ?? "edit"}
      decoded={decoded}
      entry={entry}
      activePanel={activePanel}
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
  ) : session?.processKind === "read-only-newer" && session.readOnly ? (
    <NewerDevelopReadOnlyPanel
      version={session.readOnly.foundVersion}
      reason={session.readOnly.message}
    />
  ) : (
    <PreparingDevelopPanel error={session?.ui.sidecarError ?? null} />
  );

  return (
    <>
      {panel}
      <DevelopPanelRail
        activePanel={activePanel}
        onSelect={onSelect}
        editingDisabled={session?.processKind !== "v3"}
      />
      <DevelopJobDrawer />
    </>
  );
}
