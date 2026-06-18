"use client";

import { useEffect } from "react";
import { fsDebug } from "@/lib/fs/debug";
import { isElectronApp } from "@/lib/fs/platform";
import { useLibraryStore } from "@/stores/library-store";

export function LibraryBootstrap() {
  const bootstrapLibrary = useLibraryStore((state) => state.bootstrapLibrary);
  const setDesktopApp = useLibraryStore((state) => state.setDesktopApp);

  useEffect(() => {
    const desktop = isElectronApp();
    fsDebug("LibraryBootstrap: mount", { desktop });
    setDesktopApp(desktop);

    if (!desktop) {
      useLibraryStore.setState({
        importError:
          "Darkroom must be run as a desktop app. Use npm run electron:dev.",
      });
      return;
    }

    void bootstrapLibrary();
  }, [bootstrapLibrary, setDesktopApp]);

  return null;
}
