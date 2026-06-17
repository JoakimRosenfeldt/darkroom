const PREFIX = "[darkroom:fs]";

export function fsDebug(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (detail) {
    console.log(PREFIX, step, detail);
  } else {
    console.log(PREFIX, step);
  }
}

export function fsDebugWarn(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (detail) {
    console.warn(PREFIX, step, detail);
  } else {
    console.warn(PREFIX, step);
  }
}

export function fsDebugError(
  step: string,
  error?: unknown,
  detail?: Record<string, unknown>,
): void {
  console.error(PREFIX, step, {
    ...detail,
    ...(error !== undefined
      ? {
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : error,
        }
      : {}),
  });
}
