"use client";

import { Link } from "react-router";
import { IconGrid, IconSliders } from "@/components/shell/icons";
import { useLibraryStore } from "@/stores/library-store";

type Module = "library" | "develop";

interface ModuleSpineProps {
  activeModule?: Module;
  developPhotoId?: string;
  onOpenDevelop?: (entryId: string) => void;
}

export function ModuleSpine({
  activeModule = "library",
  developPhotoId,
  onOpenDevelop,
}: ModuleSpineProps) {
  const entries = useLibraryStore((state) => state.entries);
  const selectedEntryId = useLibraryStore((state) => state.selectedEntryId);
  const needsFolderAccess = useLibraryStore((state) => state.needsFolderAccess);
  const developTargetId = developPhotoId ?? selectedEntryId ?? entries[0]?.id;
  const hasPhotos = developTargetId !== undefined && !needsFolderAccess;

  const modules = [
    {
      id: "library" as const,
      label: "LIB",
      title: "Library",
      href: "/",
      enabled: true,
      icon: IconGrid,
    },
    {
      id: "develop" as const,
      label: "DEV",
      title: "Develop",
      href: "/",
      enabled: hasPhotos && (onOpenDevelop !== undefined || activeModule === "develop"),
      icon: IconSliders,
    },
  ];

  return (
    <nav
      className="flex w-16 shrink-0 flex-col items-center gap-2 border-r border-lr-border-subtle bg-lr-panel py-3.5"
      aria-label="Modules"
    >
      <Link
        to="/"
        className="mb-2 flex h-7 w-7 items-center justify-center"
        aria-label="Darkroom library"
      >
        <span
          className="h-3 w-3 rounded-[3px] bg-lr-accent"
          aria-hidden="true"
        />
      </Link>

      {modules.map((module) => {
        const Icon = module.icon;
        const isActive = module.id === activeModule;
        const className = [
          "flex h-11 w-11 flex-col items-center justify-center gap-[3px] rounded-[10px] text-[9px] font-medium tracking-[0.04em] transition-colors",
          isActive
            ? "bg-lr-selection text-lr-accent"
            : module.enabled
              ? "text-lr-text-dim hover:bg-lr-panel-raised hover:text-lr-text"
              : "cursor-not-allowed text-lr-text-faint opacity-45",
        ].join(" ");

        const content = (
          <>
            <Icon className="h-4 w-4" />
            <span>{module.label}</span>
          </>
        );

        return isActive ? (
          <span
            key={module.id}
            className={className}
            title={module.title}
            aria-current="page"
          >
            {content}
          </span>
        ) : module.enabled && module.id === "develop" && onOpenDevelop && developTargetId ? (
          <button
            key={module.id}
            type="button"
            onClick={() => onOpenDevelop(developTargetId)}
            className={className}
            title={module.title}
            aria-current={isActive ? "page" : undefined}
          >
            {content}
          </button>
        ) : module.enabled ? (
          <Link
            key={module.id}
            to={module.href}
            className={className}
            title={module.title}
            aria-current={isActive ? "page" : undefined}
          >
            {content}
          </Link>
        ) : (
          <span
            key={module.id}
            className={className}
            title="Import a folder to open Develop"
            aria-disabled="true"
          >
            {content}
          </span>
        );
      })}

      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event("darkroom:open-preferences"))}
        title="Preferences"
        aria-label="Preferences"
        className="mt-auto flex h-11 w-14 flex-col items-center justify-center gap-1 rounded-[10px] text-[9px] font-medium text-lr-text-dim transition-colors hover:bg-lr-panel-raised hover:text-lr-text"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
          <path d="m9 3-.6 2.3-2 .9-2.1-.7-2 3.5 1.6 1.6v2.8L2.3 15l2 3.5 2.1-.7 2 .9L9 21h4l.6-2.3 2-.9 2.1.7 2-3.5-1.6-1.6v-2.8L19.7 9l-2-3.5-2.1.7-2-.9L13 3Z" />
          <circle cx="11" cy="12" r="3" />
        </svg>
        <span>Prefs</span>
      </button>
    </nav>
  );
}
