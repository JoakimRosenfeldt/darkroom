const MAX_CONCURRENT_THUMBNAILS = 2;

let active = 0;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT_THUMBNAILS) {
    active += 1;
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    waitQueue.push(() => {
      active += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  active -= 1;
  const next = waitQueue.shift();
  if (next) {
    next();
  }
}

export async function withThumbnailSlot<T>(
  operation: () => Promise<T>,
): Promise<T> {
  await acquireSlot();
  try {
    return await operation();
  } finally {
    releaseSlot();
  }
}
