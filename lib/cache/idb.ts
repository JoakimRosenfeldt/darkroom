const DB_NAME = "darkroom";
const STORE_NAME = "kv";
const LEGACY_DB_NAME = "keyval-store";
const LEGACY_STORE_NAME = "keyval";
const connections = new Map<string, Promise<IDBDatabase>>();

function openDb(
  dbName = DB_NAME,
  storeName = STORE_NAME,
  createStore = true,
): Promise<IDBDatabase> {
  const cached = connections.get(dbName);
  if (cached) return cached;
  const connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.close();
        reject(new Error(`IndexedDB store "${storeName}" was not found.`));
        return;
      }
      request.result.onversionchange = () => {
        request.result.close();
        if (connections.get(dbName) === connection) connections.delete(dbName);
      };
      request.result.onclose = () => {
        if (connections.get(dbName) === connection) connections.delete(dbName);
      };
      resolve(request.result);
    };
    request.onupgradeneeded = () => {
      if (createStore) {
        request.result.createObjectStore(storeName);
        return;
      }
      request.transaction?.abort();
    };
  });
  connections.set(dbName, connection);
  void connection.catch(() => {
    if (connections.get(dbName) === connection) connections.delete(dbName);
  });
  return connection;
}

async function readFromStore<T>(
  dbName: string,
  storeName: string,
  key: string,
  createStore = true,
): Promise<T | undefined> {
  const db = await openDb(dbName, storeName, createStore);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result as T | undefined);
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const stored = await readFromStore<T>(DB_NAME, STORE_NAME, key);
  if (stored !== undefined) {
    return stored;
  }

  try {
    const legacy = await readFromStore<T>(
      LEGACY_DB_NAME,
      LEGACY_STORE_NAME,
      key,
      false,
    );
    if (legacy !== undefined) {
      void idbSet(key, legacy).catch(() => {
        // Cache migration is best-effort.
      });
    }
    return legacy;
  } catch {
    return undefined;
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const request = tx.objectStore(STORE_NAME).put(value, key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

export async function idbDel(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const request = tx.objectStore(STORE_NAME).delete(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}
