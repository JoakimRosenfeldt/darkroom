"use client";

import { useEffect } from "react";
import { fsDebug } from "@/lib/fs/debug";
import { useLibraryStore } from "@/stores/library-store";

export function LibraryBootstrap() {
  const bootstrapLibrary = useLibraryStore((state) => state.bootstrapLibrary);
  const setSupportedBrowser = useLibraryStore(
    (state) => state.setSupportedBrowser,
  );

  useEffect(() => {
    const supported = "showDirectoryPicker" in window;
    fsDebug("LibraryBootstrap: mount", {
      supported,
      origin: window.location.origin,
    });
    setSupportedBrowser(supported);
    void bootstrapLibrary();
  }, [bootstrapLibrary, setSupportedBrowser]);

  return null;
}
