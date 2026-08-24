export const VIEWER_SESSION_VERSION = 1;

export interface ViewerSession {
  readonly version: typeof VIEWER_SESSION_VERSION;
  readonly id: string;
  readonly queryRevision: string;
  readonly orderedEntryIds: readonly string[];
  readonly activeEntryId: string;
  readonly origin: {
    readonly selectedEntryIds: readonly string[];
    readonly focusedEntryId: string | null;
    readonly scrollAnchorEntryId: string | null;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ResolvedViewerSession {
  readonly session: ViewerSession;
  readonly status: "exact" | "rebased" | "rebuilt";
  readonly message: string | null;
}

const STORAGE_PREFIX = "darkroom:viewer-session:";
const sessions = new Map<string, ViewerSession>();

function parseSession(value: unknown): ViewerSession | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = Object.fromEntries(Object.entries(value));
  if (
    input.version !== VIEWER_SESSION_VERSION ||
    typeof input.id !== "string" ||
    typeof input.queryRevision !== "string" ||
    !Array.isArray(input.orderedEntryIds) ||
    input.orderedEntryIds.some((id) => typeof id !== "string") ||
    typeof input.activeEntryId !== "string" ||
    typeof input.createdAt !== "number" ||
    typeof input.updatedAt !== "number" ||
    typeof input.origin !== "object" || input.origin === null || Array.isArray(input.origin)
  ) return null;
  const origin = Object.fromEntries(Object.entries(input.origin));
  if (
    !Array.isArray(origin.selectedEntryIds) ||
    origin.selectedEntryIds.some((id) => typeof id !== "string") ||
    (origin.focusedEntryId !== null && typeof origin.focusedEntryId !== "string") ||
    (origin.scrollAnchorEntryId !== null && typeof origin.scrollAnchorEntryId !== "string")
  ) return null;
  return {
    version: VIEWER_SESSION_VERSION,
    id: input.id,
    queryRevision: input.queryRevision,
    orderedEntryIds: [...input.orderedEntryIds],
    activeEntryId: input.activeEntryId,
    origin: {
      selectedEntryIds: [...origin.selectedEntryIds],
      focusedEntryId: origin.focusedEntryId,
      scrollAnchorEntryId: origin.scrollAnchorEntryId,
    },
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function persist(session: ViewerSession): void {
  sessions.set(session.id, session);
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(`${STORAGE_PREFIX}${session.id}`, JSON.stringify(session));
}

export function createViewerSession(input: {
  readonly queryRevision: string;
  readonly orderedEntryIds: readonly string[];
  readonly activeEntryId: string;
  readonly selectedEntryIds: readonly string[];
  readonly focusedEntryId?: string | null;
  readonly scrollAnchorEntryId?: string | null;
}): ViewerSession {
  const now = Date.now();
  const session: ViewerSession = {
    version: VIEWER_SESSION_VERSION,
    id: crypto.randomUUID(),
    queryRevision: input.queryRevision,
    orderedEntryIds: [...input.orderedEntryIds],
    activeEntryId: input.activeEntryId,
    origin: {
      selectedEntryIds: [...input.selectedEntryIds],
      focusedEntryId: input.focusedEntryId ?? input.activeEntryId,
      scrollAnchorEntryId: input.scrollAnchorEntryId ?? input.activeEntryId,
    },
    createdAt: now,
    updatedAt: now,
  };
  persist(session);
  return session;
}

export function getViewerSession(id: string): ViewerSession | null {
  const memory = sessions.get(id);
  if (memory) return memory;
  if (typeof window === "undefined") return null;
  try {
    const parsed = parseSession(JSON.parse(window.sessionStorage.getItem(`${STORAGE_PREFIX}${id}`) ?? "null"));
    if (parsed) sessions.set(id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function resolveViewerSession(input: {
  readonly sessionId: string | null;
  readonly requestedEntryId: string;
  readonly liveEntryIds: readonly string[];
  readonly liveRevision: string;
  readonly selectedEntryIds: readonly string[];
}): ResolvedViewerSession {
  const liveIds = [...input.liveEntryIds];
  const liveSet = new Set(liveIds);
  const existing = input.sessionId ? getViewerSession(input.sessionId) : null;
  if (!existing) {
    const activeEntryId = liveSet.has(input.requestedEntryId) ? input.requestedEntryId : liveIds[0] ?? input.requestedEntryId;
    return {
      session: createViewerSession({
        queryRevision: input.liveRevision,
        orderedEntryIds: liveIds,
        activeEntryId,
        selectedEntryIds: input.selectedEntryIds,
      }),
      status: "rebuilt",
      message: input.sessionId ? "The viewer session expired and was rebuilt from the current library view." : null,
    };
  }
  const retained = existing.orderedEntryIds.filter((id) => liveSet.has(id));
  const added = liveIds.filter((id) => !existing.orderedEntryIds.includes(id));
  const orderedEntryIds = [...retained, ...added];
  let activeEntryId = liveSet.has(input.requestedEntryId) ? input.requestedEntryId : existing.activeEntryId;
  if (!liveSet.has(activeEntryId)) {
    const previousIndex = Math.max(0, existing.orderedEntryIds.indexOf(existing.activeEntryId));
    activeEntryId = orderedEntryIds[Math.min(previousIndex, Math.max(0, orderedEntryIds.length - 1))] ?? input.requestedEntryId;
  }
  const changed = existing.queryRevision !== input.liveRevision || orderedEntryIds.join("\u001f") !== existing.orderedEntryIds.join("\u001f") || activeEntryId !== existing.activeEntryId;
  const session: ViewerSession = changed
    ? { ...existing, queryRevision: input.liveRevision, orderedEntryIds, activeEntryId, updatedAt: Date.now() }
    : existing;
  if (changed) persist(session);
  return {
    session,
    status: changed ? "rebased" : "exact",
    message: changed ? "The library result changed. Viewer order was safely rebased." : null,
  };
}

export function updateViewerSessionActive(id: string, activeEntryId: string): void {
  const current = getViewerSession(id);
  if (!current || current.activeEntryId === activeEntryId) return;
  persist({ ...current, activeEntryId, updatedAt: Date.now() });
}

export function viewerPhotoHref(entryId: string, sessionId: string): string {
  return `/photo?id=${encodeURIComponent(entryId)}&session=${encodeURIComponent(sessionId)}`;
}
