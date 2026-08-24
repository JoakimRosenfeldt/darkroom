const REFERENCE_PREFIX = "darkroom:viewer-reference:";

export function readReferenceEntryId(catalogId: string): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(`${REFERENCE_PREFIX}${catalogId}`);
}

export function writeReferenceEntryId(catalogId: string, entryId: string | null): void {
  if (typeof window === "undefined") return;
  const key = `${REFERENCE_PREFIX}${catalogId}`;
  if (entryId === null) window.sessionStorage.removeItem(key);
  else window.sessionStorage.setItem(key, entryId);
}
