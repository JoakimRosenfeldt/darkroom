"use client";

import { useCallback, useRef, type ReactNode } from "react";
import {
  formatPickerError,
  openPhotoFolderPicker,
} from "@/lib/fs/access";
import { fsDebug, fsDebugError } from "@/lib/fs/debug";
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
    fsDebug("handlePickerFailure: user cancelled picker");
    return;
  }

  fsDebugError("handlePickerFailure", error, { mode });
  const { folderName, entries } = useLibraryStore.getState();

  useLibraryStore.setState({
    importState: "idle",
    importError: formatPickerError(error),
    importStatus: null,
    needsFolderAccess: Boolean(folderName) || entries.length === 0,
  });
}

function startFolderPick(mode: "import" | "restore"): void {
  const { folderName, entries, importState } = useLibraryStore.getState();

  fsDebug("startFolderPick: click", {
    mode,
    folderName,
    entryCount: entries.length,
    importState,
  });

  void openPhotoFolderPicker()
    .then((result) => {
      fsDebug("startFolderPick: picker resolved, starting scan", {
        mode,
        folderName: result.name,
        rootPath: result.path,
      });
      useLibraryStore
        .getState()
        .importFromFolderPath(result.path, result.name, mode);
    })
    .catch((error) => {
      handlePickerFailure(error, mode);
    });
}

export function FolderPickerButton({
  mode,
  className,
  disabled = false,
  children,
}: FolderPickerButtonProps) {
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const setButtonRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) {
      return;
    }

    button.onclick = (event) => {
      if (disabledRef.current || event.button !== 0) {
        return;
      }
      startFolderPick(modeRef.current);
    };
  }, []);

  return (
    <button
      ref={setButtonRef}
      type="button"
      className={className}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
