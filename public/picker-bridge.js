/**
 * Folder picker bridge — runs outside the Next.js/webpack bundle so
 * showDirectoryPicker keeps a clean call stack (macOS Chrome can hang
 * when the API is invoked from bundled module code in some setups).
 */
(function () {
  /** @type {Promise<FileSystemDirectoryHandle> | null} */
  let activePicker = null;

  const PICKER_TIMEOUT_MS = 120_000;

  function log(step, detail) {
    const prefix = "[darkroom:picker-bridge]";
    if (detail !== undefined) {
      console.log(prefix, step, detail);
    } else {
      console.log(prefix, step);
    }
  }

  function warn(step, detail) {
    console.warn("[darkroom:picker-bridge]", step, detail);
  }

  function isNativePicker() {
    try {
      return /\[native code\]/.test(String(window.showDirectoryPicker));
    } catch {
      return false;
    }
  }

  /**
   * @param {string} mode
   * @returns {Promise<FileSystemDirectoryHandle>}
   */
  function open(mode) {
    if (!("showDirectoryPicker" in window)) {
      return Promise.reject(
        new Error("Folder import requires a Chromium-based browser."),
      );
    }

    if (!isNativePicker()) {
      warn("showDirectoryPicker is not native — a browser extension may have patched it", {
        impl: String(window.showDirectoryPicker).slice(0, 120),
      });
    }

    if (activePicker) {
      warn("picker already active — returning existing promise");
      return activePicker;
    }

    if (window.self !== window.top) {
      warn("page is embedded in an iframe — File System Access may not work", {
        origin: window.location.origin,
      });
    }

    log("opening system dialog", {
      mode,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      native: isNativePicker(),
    });

    const nativePromise = window.showDirectoryPicker({
      mode: "read",
      id: "darkroom-library",
    });

    let timeoutId = 0;
    let focusRecoveryId = 0;
    /** @type {((reason: Error) => void) | null} */
    let rejectRaced = null;

    const onFocusWhileWaiting = () => {
      if (!activePicker) {
        return;
      }
      window.clearTimeout(focusRecoveryId);
      focusRecoveryId = window.setTimeout(() => {
        if (activePicker !== raced || !rejectRaced) {
          return;
        }
        warn("picker hung after dialog closed — releasing for retry");
        activePicker = null;
        rejectRaced(
          new Error(
            "Folder picker did not respond after you closed the dialog. Reload the page, then try again. Disable browser extensions if this keeps happening.",
          ),
        );
      }, 2_000);
    };

    window.addEventListener("focus", onFocusWhileWaiting);

    const raced = new Promise((resolve, reject) => {
      rejectRaced = reject;

      timeoutId = window.setTimeout(() => {
        if (activePicker === raced) {
          activePicker = null;
        }
        reject(
          new Error(
            "Folder picker did not respond. Reload the page and try again. If it keeps happening, test in an incognito window or disable browser extensions.",
          ),
        );
      }, PICKER_TIMEOUT_MS);

      nativePromise.then(
        (handle) => {
          window.clearTimeout(timeoutId);
          window.clearTimeout(focusRecoveryId);
          window.removeEventListener("focus", onFocusWhileWaiting);
          log("user selected folder", { folderName: handle.name });
          resolve(handle);
        },
        (error) => {
          window.clearTimeout(timeoutId);
          window.clearTimeout(focusRecoveryId);
          window.removeEventListener("focus", onFocusWhileWaiting);
          log("picker rejected", {
            name: error && error.name,
            message: error && error.message,
          });
          reject(error);
        },
      );
    });

    activePicker = raced;

    void raced.finally(() => {
      log("picker settled");
      window.clearTimeout(focusRecoveryId);
      window.removeEventListener("focus", onFocusWhileWaiting);
      if (activePicker === raced) {
        activePicker = null;
      }
      rejectRaced = null;
    });

    return raced;
  }

  window.DarkroomPickerBridge = {
    open,
    isActive: function () {
      return activePicker !== null;
    },
    isNativePicker,
  };
})();
