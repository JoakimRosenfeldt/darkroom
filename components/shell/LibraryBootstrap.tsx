"use client";

import { useEffect } from "react";
import { isElectronApp } from "@/lib/fs/platform";
import { useLibraryStore } from "@/stores/library-store";

export function LibraryBootstrap() {
  const bootstrapLibrary = useLibraryStore((state) => state.bootstrapLibrary);
  const importStatus = useLibraryStore((state) => state.importStatus);
  const importError = useLibraryStore((state) => state.importError);

  useEffect(() => {
    if (importStatus) {
      console.log(`[Darkroom] ${importStatus}`);
    }
  }, [importStatus]);

  useEffect(() => {
    if (importError) {
      console.error(`[Darkroom] ${importError}`);
    }
  }, [importError]);

  useEffect(() => {
    if (!isElectronApp()) {
      useLibraryStore.setState({
        importError:
          "Darkroom must be run as a desktop app. Use npm run electron:dev.",
      });
      return;
    }

    void bootstrapLibrary();
  }, [bootstrapLibrary]);

  return null;
}
