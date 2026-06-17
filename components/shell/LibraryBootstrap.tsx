"use client";

import { useEffect } from "react";
import { useLibraryStore } from "@/stores/library-store";

export function LibraryBootstrap() {
  const restoreLastFolder = useLibraryStore((state) => state.restoreLastFolder);
  const setSupportedBrowser = useLibraryStore(
    (state) => state.setSupportedBrowser,
  );

  useEffect(() => {
    setSupportedBrowser("showDirectoryPicker" in window);
    void restoreLastFolder();
  }, [restoreLastFolder, setSupportedBrowser]);

  return null;
}
