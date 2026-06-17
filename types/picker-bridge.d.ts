interface DarkroomPickerBridge {
  open(mode: string): Promise<FileSystemDirectoryHandle>;
  isActive(): boolean;
  isNativePicker(): boolean;
}

interface Window {
  DarkroomPickerBridge?: DarkroomPickerBridge;
}
