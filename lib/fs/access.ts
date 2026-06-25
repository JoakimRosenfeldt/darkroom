import { getDarkroomAPI } from "./platform";

/**
 * Open the native folder picker. Must be called from a user gesture handler.
 */
export async function openPhotoFolderPicker(): Promise<{
  path: string;
  name: string;
}> {
  const api = getDarkroomAPI();
  const result = await api.pickFolder();
  if (!result) {
    throw new DOMException("Folder selection was cancelled.", "AbortError");
  }

  return result;
}

export function formatPickerError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "AbortError") {
      return "Folder selection was cancelled.";
    }
    return `${error.name}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "An unexpected error occurred.";
}
