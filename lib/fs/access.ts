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
