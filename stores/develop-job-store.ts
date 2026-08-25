import { create } from "zustand";
import { getDarkroomAPI } from "@/lib/fs/platform";
import type { DevelopJobSnapshot } from "@/lib/develop/v3/jobs";

interface DevelopJobStore {
  readonly jobs: readonly DevelopJobSnapshot[];
  readonly hydrated: boolean;
  readonly error: string | null;
  readonly initialize: () => () => void;
  readonly refresh: () => Promise<void>;
  readonly replaceJobs: (jobs: readonly DevelopJobSnapshot[]) => void;
}

let consumers = 0;
let unsubscribe: (() => void) | null = null;
let refreshPromise: Promise<void> | null = null;
let updateRevision = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Develop jobs could not be loaded.";
}

export const useDevelopJobStore = create<DevelopJobStore>((set, get) => ({
  jobs: [],
  hydrated: false,
  error: null,

  replaceJobs: (jobs) => {
    updateRevision += 1;
    set({ jobs, hydrated: true, error: null });
  },

  refresh: () => {
    if (refreshPromise) return refreshPromise;

    const revisionAtStart = updateRevision;
    refreshPromise = (async () => {
      try {
        const jobs = await getDarkroomAPI().developJobsList();
        if (revisionAtStart === updateRevision) {
          set({ jobs, hydrated: true, error: null });
        }
      } catch (error) {
        if (revisionAtStart === updateRevision) {
          set({ hydrated: true, error: errorMessage(error) });
        }
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  },

  initialize: () => {
    consumers += 1;
    if (consumers === 1) {
      try {
        unsubscribe = getDarkroomAPI().onDevelopJobsUpdated(get().replaceJobs);
        void get().refresh();
      } catch (error) {
        set({ hydrated: true, error: errorMessage(error) });
      }
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      consumers -= 1;
      if (consumers === 0) {
        unsubscribe?.();
        unsubscribe = null;
      }
    };
  },
}));
