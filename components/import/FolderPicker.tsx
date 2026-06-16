"use client";

import { useEffect } from "react";
import { useLibraryStore } from "@/stores/library-store";

export function FolderPicker() {
  const {
    folderName,
    importState,
    importError,
    isSupportedBrowser,
    pickFolder,
    restoreLastFolder,
    setSupportedBrowser,
  } = useLibraryStore();

  useEffect(() => {
    setSupportedBrowser("showDirectoryPicker" in window);
    void restoreLastFolder();
  }, [restoreLastFolder, setSupportedBrowser]);

  if (!isSupportedBrowser) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
        Darkroom requires a Chromium-based browser (Chrome or Edge) for local
        folder access. Your photos never leave your device.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void pickFolder()}
          disabled={importState === "importing" || importState === "restoring"}
          className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {importState === "importing" ? "Scanning folder..." : "Open folder"}
        </button>

        {folderName ? (
          <button
            type="button"
            onClick={() => void restoreLastFolder()}
            disabled={importState === "importing" || importState === "restoring"}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {importState === "restoring" ? "Restoring..." : "Re-grant access"}
          </button>
        ) : null}
      </div>

      {folderName ? (
        <p className="text-sm text-zinc-400">
          Current library: <span className="text-zinc-200">{folderName}</span>
        </p>
      ) : (
        <p className="text-sm text-zinc-500">
          Pick a local folder to browse photos in place. Files are read on demand
          and are never uploaded.
        </p>
      )}

      {importError ? (
        <p className="text-sm text-red-300">{importError}</p>
      ) : null}
    </div>
  );
}
