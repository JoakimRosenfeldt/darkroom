export function isFileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && window.darkroom?.isElectron === true;
}
