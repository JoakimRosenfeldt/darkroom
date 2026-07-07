"use client";

import { useState } from "react";
import type { LibraryEntry } from "@/lib/fs/types";
import type { DevelopImage } from "@/lib/cache/develop-image-cache";
import { CropPanel } from "@/components/develop/CropPanel";
import { EditPanel } from "@/components/develop/EditPanel";
import {
  DevelopPanelRail,
  type DevelopPanelId,
} from "@/components/develop/DevelopPanelRail";
import { MetadataPanel } from "@/components/viewer/MetadataPanel";

interface DevelopSidePanelsProps {
  decoded: DevelopImage;
  entry: LibraryEntry;
}

export function DevelopSidePanels({ decoded, entry }: DevelopSidePanelsProps) {
  const [activePanel, setActivePanel] = useState<DevelopPanelId | null>("edit");

  function selectPanel(panel: DevelopPanelId) {
    setActivePanel((current) => (current === panel ? null : panel));
  }

  return (
    <>
      {activePanel === "crop" ? <CropPanel /> : null}
      {activePanel === "edit" ? <EditPanel /> : null}
      {activePanel === "info" ? (
        <MetadataPanel
          metadata={decoded.metadata}
          fileName={entry.name}
          profileId={entry.profileId}
        />
      ) : null}
      <DevelopPanelRail activePanel={activePanel} onSelect={selectPanel} />
    </>
  );
}
