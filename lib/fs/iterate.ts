interface FileSystemDirectoryHandleAsyncIterator
  extends FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  keys(): AsyncIterableIterator<string>;
}

export async function* iterateDirectory(
  dirHandle: FileSystemDirectoryHandle,
): AsyncGenerator<FileSystemHandle> {
  const handle = dirHandle as FileSystemDirectoryHandleAsyncIterator;
  yield* handle.values();
}
