"use client";

import Link from "next/link";
import { useLibraryStore } from "@/stores/library-store";

type Module = "library" | "develop";

interface TopBarProps {
  activeModule?: Module;
  showBack?: boolean;
  title?: string;
  developPhotoId?: string;
}

export function TopBar({
  activeModule = "library",
  showBack = false,
  title,
  developPhotoId,
}: TopBarProps) {
  const entries = useLibraryStore((state) => state.entries);
  const selectedEntryId = useLibraryStore((state) => state.selectedEntryId);
  const needsFolderAccess = useLibraryStore((state) => state.needsFolderAccess);
  const hasPhotos = entries.length > 0 && !needsFolderAccess;

  const developTargetId =
    developPhotoId ?? selectedEntryId ?? entries[0]?.id;
  const developHref = developTargetId
    ? `/photo?id=${encodeURIComponent(developTargetId)}`
    : "/photo";

  const modules: Array<{
    id: Module;
    label: string;
    href: string;
    enabled: boolean;
  }> = [
    { id: "library", label: "Library", href: "/", enabled: true },
    { id: "develop", label: "Develop", href: developHref, enabled: hasPhotos },
  ];

  return (
    <header className="flex h-10 shrink-0 items-stretch border-b border-lr-border-subtle bg-lr-toolbar">
      <div className="flex items-stretch border-r border-lr-border-subtle">
        {modules.map((module) => {
          const isActive = module.id === activeModule;
          const className = [
            "flex items-center px-4 text-xs font-medium tracking-wide transition-colors",
            isActive
              ? "bg-lr-panel text-lr-text"
              : module.enabled
                ? "text-lr-text-muted hover:bg-lr-panel/60 hover:text-lr-text"
                : "cursor-not-allowed text-lr-text-dim",
          ].join(" ");

          if (!module.enabled) {
            return (
              <span
                key={module.id}
                className={className}
                title={
                  module.id === "develop"
                    ? "Import a folder to open Develop"
                    : "Unavailable"
                }
              >
                {module.label}
              </span>
            );
          }

          return (
            <Link key={module.id} href={module.href} className={className}>
              {module.label}
            </Link>
          );
        })}
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-3 px-3">
        {showBack ? (
          <Link
            href="/"
            className="flex items-center gap-1 text-lr-text-muted transition hover:text-lr-text"
          >
            <span className="text-lr-accent">Library</span>
            <span>/</span>
          </Link>
        ) : (
          <span className="text-xs font-semibold tracking-tight text-lr-text-muted">
            Darkroom
          </span>
        )}
        {title ? (
          <span className="truncate text-xs text-lr-text">{title}</span>
        ) : null}
      </div>

      <div className="flex items-center border-l border-lr-border-subtle px-3 text-[11px] text-lr-text-dim">
        Desktop · Local files
      </div>
    </header>
  );
}
