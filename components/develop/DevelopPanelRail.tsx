"use client";

import { IconCopy, IconCrop, IconInfo, IconMask, IconRotate, IconSliders } from "@/components/shell/icons";

export type DevelopPanelId = "crop" | "edit" | "masking" | "cleanup" | "defaults" | "history" | "info";

interface DevelopPanelRailProps {
  activePanel: DevelopPanelId | null;
  onSelect: (panel: DevelopPanelId) => void;
  editingDisabled?: boolean;
}

const PANELS: Array<{ id: DevelopPanelId; label: string; icon: typeof IconSliders }> = [
  { id: "crop", label: "Crop", icon: IconCrop },
  { id: "edit", label: "Edit", icon: IconSliders },
  { id: "masking", label: "Masking", icon: IconMask },
  { id: "cleanup", label: "Cleanup", icon: IconCopy },
  { id: "history", label: "History", icon: IconRotate },
  { id: "info", label: "Info", icon: IconInfo },
];

export function DevelopPanelRail({
  activePanel,
  onSelect,
  editingDisabled = false,
}: DevelopPanelRailProps) {
  return (
    <nav
      className="flex w-16 shrink-0 flex-col items-center gap-1.5 border-l border-lr-border-subtle bg-lr-panel py-3"
      aria-label="Develop panels"
    >
      {PANELS.map(({ id, label, icon: Icon }) => {
        const isActive = activePanel === id;
        const disabled = editingDisabled && id !== "info" && id !== "history" && id !== "defaults";
        return (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={isActive}
            disabled={disabled}
            onClick={() => onSelect(id)}
            className={[
              "flex h-12 w-14 flex-col items-center justify-center gap-0.5 rounded-[9px] text-[11px] tracking-[0.06em] transition",
              disabled
                ? "cursor-not-allowed text-lr-text-faint opacity-40"
                : isActive
                ? "bg-lr-panel-raised text-lr-text"
                : "text-lr-text-dim hover:bg-lr-panel-raised hover:text-lr-text-muted",
            ].join(" ")}
          >
            <Icon className="h-[15px] w-[15px]" />
            <span aria-hidden="true">{label === "Masking" ? "Mask" : label}</span>
          </button>
        );
      })}
      <details className="mt-auto text-xs text-lr-text-muted"><summary className="cursor-pointer py-3">More</summary><button type="button" className="py-2" onClick={() => onSelect("defaults")}>Defaults</button></details>
    </nav>
  );
}
