"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { COLOR_LABEL_HEX } from "@/lib/catalog/defaults";
import { COLOR_LABELS } from "@/lib/catalog/types";
import { useLibraryStore } from "@/stores/library-store";

interface ContextMenuState {
  x: number;
  y: number;
  entryId: string;
}

function getActionTargets(
  entryId: string,
  selectedEntryIds: string[],
): string[] {
  if (selectedEntryIds.includes(entryId)) {
    return selectedEntryIds;
  }
  return [entryId];
}

export function useLibraryContextMenu(visibleOrder: string[]) {
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const selectedEntryIds = useLibraryStore((state) => state.selectedEntryIds);
  const selectEntry = useLibraryStore((state) => state.selectEntry);
  const albums = useLibraryStore((state) => state.albums);
  const createAlbum = useLibraryStore((state) => state.createAlbum);
  const addEntriesToAlbum = useLibraryStore((state) => state.addEntriesToAlbum);
  const applyMetadataToEntries = useLibraryStore(
    (state) => state.applyMetadataToEntries,
  );

  const actionTargets = useMemo(
    () => (menu ? getActionTargets(menu.entryId, selectedEntryIds) : []),
    [menu, selectedEntryIds],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  const openContextMenu = useCallback(
    (entryId: string, event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (!selectedEntryIds.includes(entryId)) {
        selectEntry(entryId, {}, visibleOrder);
      }

      setMenu({ x: event.clientX, y: event.clientY, entryId });
      setPosition(null);
    },
    [selectEntry, selectedEntryIds, visibleOrder],
  );

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      return;
    }

    const rect = menuRef.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const y = Math.min(menu.y, window.innerHeight - rect.height - 8);
    setPosition({
      x: Math.max(8, x),
      y: Math.max(8, y),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeMenu();
      }
    }

    function onPointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      closeMenu();
    }

    function onScroll() {
      closeMenu();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [closeMenu, menu]);

  const applyToTargets = useCallback(
    (patch: Parameters<typeof applyMetadataToEntries>[1]) => {
      if (actionTargets.length === 0) {
        return;
      }
      applyMetadataToEntries(actionTargets, patch);
      closeMenu();
    },
    [actionTargets, applyMetadataToEntries, closeMenu],
  );

  const contextMenu =
    menu && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            className="fixed z-50 min-w-[180px] rounded border border-lr-border bg-lr-panel py-1 shadow-lg"
            style={{
              left: position?.x ?? menu.x,
              top: position?.y ?? menu.y,
            }}
            role="menu"
          >
            <ContextMenuItem
              onClick={() => {
                router.push(
                  `/photo?id=${encodeURIComponent(menu.entryId)}`,
                );
                closeMenu();
              }}
            >
              Open in Develop
            </ContextMenuItem>

            <ContextMenuSeparator />

            <ContextMenuItem onClick={() => applyToTargets({ pick: "pick" })}>
              Pick
              <ShortcutHint>P</ShortcutHint>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => applyToTargets({ pick: "reject" })}>
              Reject
              <ShortcutHint>X</ShortcutHint>
            </ContextMenuItem>
            <ContextMenuItem onClick={() => applyToTargets({ pick: "none" })}>
              Unflagged
              <ShortcutHint>U</ShortcutHint>
            </ContextMenuItem>

            <ContextMenuSeparator />

            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim">
              Rating
            </div>
            {([1, 2, 3, 4, 5] as const).map((rating) => (
              <ContextMenuItem
                key={rating}
                onClick={() =>
                  applyToTargets({ rating })
                }
              >
                {"★".repeat(rating)}
                <span className="text-lr-text-dim">
                  {rating === 1 ? " star" : " stars"}
                </span>
                <ShortcutHint>{rating}</ShortcutHint>
              </ContextMenuItem>
            ))}
            <ContextMenuItem onClick={() => applyToTargets({ rating: 0 })}>
              Clear rating
              <ShortcutHint>0</ShortcutHint>
            </ContextMenuItem>

            <ContextMenuSeparator />

            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim">
              Color label
            </div>
            {COLOR_LABELS.map((label, index) => (
              <ContextMenuItem
                key={label}
                onClick={() => applyToTargets({ colorLabel: label })}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: COLOR_LABEL_HEX[label] }}
                />
                <span className="capitalize">{label}</span>
                <ShortcutHint>{index + 6}</ShortcutHint>
              </ContextMenuItem>
            ))}
            <ContextMenuItem onClick={() => applyToTargets({ colorLabel: null })}>
              Clear label
            </ContextMenuItem>

            <ContextMenuSeparator />

            <div className="flex items-center px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-lr-text-dim">
              <span>Add to album</span>
              <ShortcutHint>B</ShortcutHint>
            </div>
            {albums.map((album) => (
              <ContextMenuItem
                key={album.id}
                onClick={() => {
                  addEntriesToAlbum(album.id, actionTargets);
                  closeMenu();
                }}
              >
                {album.name}
              </ContextMenuItem>
            ))}
            <ContextMenuItem
              onClick={() => {
                const name = `Album ${albums.length + 1}`;
                const albumId = createAlbum(name);
                if (albumId) {
                  addEntriesToAlbum(albumId, actionTargets);
                }
                closeMenu();
              }}
            >
              New album…
            </ContextMenuItem>

            {actionTargets.length > 1 ? (
              <>
                <ContextMenuSeparator />
                <div className="px-3 py-1.5 text-[10px] text-lr-text-dim">
                  {actionTargets.length} photos selected
                </div>
              </>
            ) : null}
          </div>,
          document.body,
        )
      : null;

  return { openContextMenu, contextMenu };
}

function ContextMenuItem({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-lr-text transition hover:bg-lr-panel-raised"
    >
      {children}
    </button>
  );
}

function ContextMenuSeparator() {
  return <div className="my-1 h-px bg-lr-border-subtle" role="separator" />;
}

function ShortcutHint({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-auto text-[10px] text-lr-text-dim">{children}</span>
  );
}
