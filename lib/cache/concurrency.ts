interface QueueItem {
  priority: number;
  sequence: number;
  start: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
}

interface RunWithLimitOptions {
  priority?: number;
  signal?: AbortSignal;
}

function createLimitRunner(maxConcurrent: number) {
  let active = 0;
  let sequence = 0;
  const waitQueue: QueueItem[] = [];

  function createAbortError(): Error {
    return new DOMException("Operation was cancelled.", "AbortError");
  }

  function removeQueuedItem(item: QueueItem): void {
    const index = waitQueue.indexOf(item);
    if (index >= 0) {
      waitQueue.splice(index, 1);
    }
  }

  function nextQueuedItem(): QueueItem | undefined {
    let bestIndex = -1;

    for (let index = 0; index < waitQueue.length; index += 1) {
      const candidate = waitQueue[index];
      if (candidate.signal?.aborted) {
        waitQueue.splice(index, 1);
        candidate.reject(createAbortError());
        index -= 1;
        continue;
      }

      if (
        bestIndex === -1 ||
        candidate.priority > waitQueue[bestIndex].priority ||
        (candidate.priority === waitQueue[bestIndex].priority &&
          candidate.sequence < waitQueue[bestIndex].sequence)
      ) {
        bestIndex = index;
      }
    }

    if (bestIndex === -1) {
      return undefined;
    }

    const [item] = waitQueue.splice(bestIndex, 1);
    return item;
  }

  function acquireSlot(options: RunWithLimitOptions = {}): Promise<void> {
    if (options.signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const item: QueueItem = {
        priority: options.priority ?? 0,
        sequence,
        signal: options.signal,
        reject,
        start: () => {
          options.signal?.removeEventListener("abort", onAbort);
          active += 1;
          resolve();
        },
      };
      sequence += 1;

      function onAbort() {
        removeQueuedItem(item);
        reject(createAbortError());
      }

      options.signal?.addEventListener("abort", onAbort, { once: true });
      waitQueue.push(item);
    });
  }

  function releaseSlot(): void {
    active -= 1;
    const next = nextQueuedItem();
    if (next) {
      next.start();
    }
  }

  return async function runWithLimit<T>(
    operation: () => Promise<T>,
    options?: RunWithLimitOptions,
  ): Promise<T> {
    await acquireSlot(options);
    try {
      return await operation();
    } finally {
      releaseSlot();
    }
  };
}

export const runWithThumbnailLimit = createLimitRunner(2);
export const runWithAspectLimit = createLimitRunner(8);
