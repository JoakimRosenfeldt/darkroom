"use client";

import type { FilterOption } from "./LibraryToolbar";

interface SidePanelProps {
  folderName: string | null;
  photoCount: number;
  rawCount: number;
  standardCount: number;
  filter: FilterOption;
  onFilterChange: (filter: FilterOption) => void;
}

export function SidePanel({
  folderName,
  photoCount,
  rawCount,
  standardCount,
  filter,
  onFilterChange,
}: SidePanelProps) {
  const filters: Array<{ id: FilterOption; label: string; count: number }> = [
    { id: "all", label: "All Photographs", count: photoCount },
    { id: "raw", label: "RAW", count: rawCount },
    { id: "standard", label: "JPEG / PNG", count: standardCount },
  ];

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-lr-border-subtle bg-lr-panel">
      <div className="border-b border-lr-border-subtle px-3 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-lr-text-dim">
          Catalog
        </h2>
      </div>

      <div className="flex-1 overflow-auto py-1">
        <section className="px-2 py-1">
          <h3 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim">
            Folders
          </h3>
          <div className="rounded px-2 py-1.5 text-xs text-lr-text">
            {folderName ? (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-lr-accent" />
                <span className="truncate">{folderName}</span>
              </span>
            ) : (
              <span className="text-lr-text-dim">No folder linked</span>
            )}
          </div>
        </section>

        <section className="mt-2 px-2 py-1">
          <h3 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim">
            Filters
          </h3>
          <ul className="space-y-0.5">
            {filters.map((item) => {
              const isActive = filter === item.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onFilterChange(item.id)}
                    className={[
                      "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition",
                      isActive
                        ? "bg-lr-selection text-lr-text"
                        : "text-lr-text-muted hover:bg-lr-panel-raised hover:text-lr-text",
                    ].join(" ")}
                  >
                    <span>{item.label}</span>
                    <span className="text-lr-text-dim">{item.count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </aside>
  );
}
