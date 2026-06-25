"use client";

import {
  useCallback,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  formatPickerError,
  openPhotoFolderPicker,
} from "@/lib/fs/access";
import { isElectronApp } from "@/lib/fs/platform";
import { useLibraryStore } from "@/stores/library-store";

interface FolderPickerButtonProps {
  mode: "import" | "restore";
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}

function handlePickerFailure(
  error: unknown,
  mode: "import" | "restore",
): void {
  if (error instanceof DOMException && error.name === "AbortError") {
    return;
  }

  console.error("[darkroom:fs] handlePickerFailure", error, { mode });
  const { folderName, entries } = useLibraryStore.getState();

  useLibraryStore.setState({
    importState: "idle",
    importError: formatPickerError(error),
    importStatus: null,
    needsFolderAccess: Boolean(folderName) || entries.length === 0,
  });
}

function startFolderPick(mode: "import" | "restore"): void {
  void openPhotoFolderPicker()
    .then((result) => {
      useLibraryStore
        .getState()
        .importFromFolderPath(result.path, result.name, mode);
    })
    .catch((error) => {
      handlePickerFailure(error, mode);
    });
}

function subscribeToDesktopApp(): () => void {
  return () => {};
}

function getDesktopAppSnapshot(): boolean {
  return isElectronApp();
}

function getServerDesktopAppSnapshot(): boolean {
  return false;
}

export function FolderPickerButton({
  mode,
  className,
  disabled = false,
  children,
}: FolderPickerButtonProps) {
  const desktopApp = useSyncExternalStore(
    subscribeToDesktopApp,
    getDesktopAppSnapshot,
    getServerDesktopAppSnapshot,
  );
  const isDisabled = disabled || !desktopApp;

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (isDisabled || event.button !== 0) {
        return;
      }
      startFolderPick(mode);
    },
    [isDisabled, mode],
  );

  return (
    <button
      type="button"
      onClick={handleClick}
      className={[
        className,
        "disabled:cursor-not-allowed disabled:opacity-50",
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={isDisabled}
    >
      {children}
    </button>
  );
}
