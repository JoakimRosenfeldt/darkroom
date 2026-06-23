export function isElectronApp(): boolean {
  return typeof window !== "undefined" && window.darkroom?.isElectron === true;
}

export function getDarkroomAPI(): NonNullable<Window["darkroom"]> {
  if (!isElectronApp() || !window.darkroom) {
    throw new Error("Darkroom desktop API is not available.");
  }
  return window.darkroom;
}

export function joinRootPath(rootPath: string, relativePath: string): string {
  const separator = rootPath.includes("\\") ? "\\" : "/";
  return `${rootPath}${separator}${relativePath.split("/").join(separator)}`;
}

export async function deleteFilesFromDisk(
  absolutePaths: string[],
): Promise<void> {
  const api = getDarkroomAPI();
  if (typeof api.deleteFiles !== "function") {
    throw new Error(
      "Remove from disk is unavailable. Quit and restart the desktop app.",
    );
  }
  await api.deleteFiles(absolutePaths);
}
