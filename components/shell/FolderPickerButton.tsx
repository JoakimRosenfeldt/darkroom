"use client";

import { useCallback, useRef, type ReactNode } from "react";
import {
  formatPickerError,
  openPhotoFolderPicker,
} from "@/lib/fs/access";
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
