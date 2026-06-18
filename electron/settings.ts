import fs from "node:fs/promises";
import path from "node:path";

export interface AppSettings {
  lastFolderPath: string | null;
}

const DEFAULT_SETTINGS: AppSettings = {
  lastFolderPath: null,
};

export function createSettingsStore(userDataPath: string) {
  const settingsPath = path.join(userDataPath, "settings.json");

  async function read(): Promise<AppSettings> {
    try {
      const raw = await fs.readFile(settingsPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async function write(settings: AppSettings): Promise<void> {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  }

  return {
    async getLastFolder(): Promise<string | null> {
      const settings = await read();
      return settings.lastFolderPath;
    },

    async setLastFolder(folderPath: string | null): Promise<void> {
      const settings = await read();
      settings.lastFolderPath = folderPath;
      await write(settings);
    },
  };
}
