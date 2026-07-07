"use client";

import { IconInfo, IconSliders } from "@/components/shell/icons";

export type DevelopPanelId = "edit" | "info";

interface DevelopPanelRailProps {
  activePanel: DevelopPanelId | null;
  onSelect: (panel: DevelopPanelId) => void;
}

const PANELS: Array<{ id: DevelopPanelId; label: string; icon: typeof IconSliders }> = [
  { id: "edit", label: "Edit", icon: IconSliders },
  { id: "info", label: "Info", icon: IconInfo },
];

export function DevelopPanelRail({ activePanel, onSelect }: DevelopPanelRailProps) {
  return (
    <nav
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-lr-border-subtle bg-lr-panel py-2"
      aria-label="Develop panels"
    >
      {PANELS.map(({ id, label, icon: Icon }) => {
        const isActive = activePanel === id;
        return (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={isActive}
            onClick={() => onSelect(id)}
            className={[
              "flex h-9 w-9 items-center justify-center rounded transition",
              isActive
                ? "bg-lr-panel-raised text-lr-text"
                : "text-lr-text-dim hover:bg-lr-panel-raised hover:text-lr-text-muted",
            ].join(" ")}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </nav>
  );
}
