"use client";

import type { ReactNode } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { CropPanel } from "@/components/develop/CropPanel";
import { EditPanel } from "@/components/develop/EditPanel";
import { MaskingPanel } from "@/components/develop/MaskingPanel";
import {
  NewerDevelopReadOnlyPanel,
  V3EditPanel,
} from "@/components/develop/V3EditPanel";
import {
  DevelopPanelRail,
  type DevelopPanelId,
} from "@/components/develop/DevelopPanelRail";
import { MetadataPanel } from "@/components/viewer/MetadataPanel";
import type { CropSettings } from "@/lib/develop/types";
import { useDevelopStore } from "@/stores/develop-store";
import type { CpuAnalysisTapResult } from "@/lib/develop/v3/cpu-backend";
import type { V3CanvasDiagnostic } from "@/components/develop/V3DevelopCanvas";

interface DevelopSidePanelsProps {
  decoded: DevelopImage;
  entry: LibraryEntry;
  activePanel: DevelopPanelId | null;
  cropDraft: CropSettings | null;
  onSelect: (panel: DevelopPanelId) => void;
  onResetAll: () => void;
  onCropChange: (crop: CropSettings, preserveFrame?: boolean) => void;
  onCropReset: () => void;
  maskingAiActions?: ReactNode;
  resultId: string;
  resultCatalogRevision: number;
  resultEntryIds: readonly string[];
  missingEntryIds: readonly string[];
  resultEntries: readonly LibraryEntry[];
  v3Analysis: readonly CpuAnalysisTapResult[];
  v3RenderDiagnostics: readonly V3CanvasDiagnostic[];
}

export function DevelopSidePanels({
  decoded,
  entry,
  activePanel,
  cropDraft,
  onSelect,
  onResetAll,
  onCropChange,
  onCropReset,
  maskingAiActions,
  resultId,
  resultCatalogRevision,
  resultEntryIds,
  missingEntryIds,
  resultEntries,
  v3Analysis,
  v3RenderDiagnostics,
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
    <V3EditPanel
      key={activePanel ?? "edit"}
      activePanel={activePanel}
      analysis={v3Analysis}
      diagnostics={v3RenderDiagnostics}
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
  ) : activePanel === "crop" ? (
    <aside className="flex w-[352px] shrink-0 flex-col border-l border-lr-border-subtle bg-lr-panel">
      <div className="flex-1 overflow-auto">
        <CropPanel
          crop={cropDraft}
          imageWidth={decoded.width}
          imageHeight={decoded.height}
          onChange={onCropChange}
          onReset={onCropReset}
        />
      </div>
    </aside>
  ) : activePanel === "masking" ? (
    <MaskingPanel
      aiActions={maskingAiActions}
      onDone={() => onSelect("edit")}
    />
  ) : (
    <EditPanel entry={entry} image={decoded} onResetAll={onResetAll} />
  );

  return (
    <>
      {panel}
      <DevelopPanelRail activePanel={activePanel} onSelect={onSelect} />
    </>
  );
}
