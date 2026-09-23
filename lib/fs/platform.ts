export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && window.darkroom?.isDesktop === true;
}

export function getDarkroomAPI(): NonNullable<Window["darkroom"]> {
  if (!isDesktopApp() || !window.darkroom) {
    throw new Error("Darkroom desktop API is not available.");
  }
  return window.darkroom;
}
