import { fsDebug, fsDebugError, fsDebugWarn } from "./debug";

export function isPhotoFolderPickerActive(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.DarkroomPickerBridge?.isActive() ?? false;
}

function getBridge(): DarkroomPickerBridge {
  if (typeof window === "undefined" || !window.DarkroomPickerBridge) {
    throw new Error(
      "Folder picker is not ready. Reload the page and try again.",
    );
  }
  return window.DarkroomPickerBridge;
}

/**
 * Open the system folder picker. Must be called synchronously from a native
 * click handler — do not await anything before this call.
 */
export function openPhotoFolderPicker(
  mode: "import" | "restore" = "import",
): Promise<FileSystemDirectoryHandle> {
  if (!("showDirectoryPicker" in window)) {
    fsDebugError("openPhotoFolderPicker: unsupported browser");
    return Promise.reject(
      new Error("Folder import requires a Chromium-based browser."),
    );
  }

  const bridge = getBridge();

  if (!bridge.isNativePicker()) {
    fsDebugWarn("openPhotoFolderPicker: showDirectoryPicker is not native", {
      hint: "Disable browser extensions that may patch the File System Access API.",
    });
  }

  if (bridge.isActive()) {
    fsDebugWarn("openPhotoFolderPicker: picker already active");
  }

  fsDebug("openPhotoFolderPicker: delegating to picker bridge", {
    mode,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    embedded: window.self !== window.top,
  });

  return bridge.open(mode);
}

export function watchPickerDiagnostics(
  picker: Promise<FileSystemDirectoryHandle>,
): void {
  const onVisibility = () => {
    fsDebug("picker: visibilitychange", {
      hidden: document.hidden,
      visibility: document.visibilityState,
    });
  };

  const onFocus = () => {
    fsDebug("picker: window focus");
  };

  const onBlur = () => {
    fsDebug("picker: window blur");
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);

  window.setTimeout(() => {
    if (!isPhotoFolderPickerActive()) {
      return;
    }
    fsDebugWarn("picker: still waiting after 5s", {
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      hint: "Click Open in the folder dialog. Test http://localhost:3000/folder-picker-test.html in the same browser tab.",
    });
  }, 5_000);

  void picker.finally(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
  });
}

export function formatPickerError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "AbortError") {
      return "Folder selection was cancelled.";
    }
    if (
      error.name === "NotAllowedError" &&
      error.message.includes("File picker already active")
    ) {
      return "A folder dialog is already open. Select a folder and click Open, or close that dialog first.";
    }
    return `${error.name}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "An unexpected error occurred.";
}
