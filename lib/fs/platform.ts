export function isElectronApp(): boolean {
  return typeof window !== "undefined" && window.darkroom?.isElectron === true;
}

export function getDarkroomAPI(): NonNullable<Window["darkroom"]> {
  if (!isElectronApp() || !window.darkroom) {
    throw new Error("Darkroom desktop API is not available.");
  }
  return window.darkroom;
}
